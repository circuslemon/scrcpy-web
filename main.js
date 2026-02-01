const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ScrcpyClient = require('./ScrcpyClient.js');

// [新增] 日誌相關套件
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

// =========================
// 路徑與設定
// =========================
const isPkg = typeof process.pkg !== 'undefined';
const exeDir = isPkg ? path.dirname(process.execPath) : __dirname;

// [新增] 日誌目錄與 Logger 初始化
const LOG_DIR = path.join(exeDir, 'logs');
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

// 設定 Winston Logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => {
            return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
        })
    ),
    transports: [
        // 檔案輸出：包含自動切割與保留機制
        new DailyRotateFile({
            filename: path.join(LOG_DIR, 'app-%DATE%.log'),
            datePattern: 'YYYY-MM-DD',
            zippedArchive: true,      // 壓縮舊日誌
            maxSize: '20m',           // 單檔最大 20MB
            maxFiles: '14d',          // 只保留 14 天
            prepend: true
        }),
        // 控制台輸出
        new winston.transports.Console()
    ]
});

// [關鍵] 覆寫全域 console，讓所有模組的輸出都自動寫入 Log
console.log = (...args) => logger.info(args.map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' '));
console.error = (...args) => logger.error(args.map(a => (a instanceof Error ? a.stack : (typeof a === 'object' ? JSON.stringify(a) : a))).join(' '));
console.info = console.log;
console.warn = console.log;

const PORT = 3000;
const ALIAS_FILE = path.join(exeDir, 'device_aliases.json');
const ADMIN_PASSWORD = 'admin'; // 請自行修改

// =========================
// 全域狀態
// =========================
const activeClients = new Map();   // serial => { client, port }
const deviceBuffers = new Map();   // serial => { sps, pps, idr }
const deviceAliases = fs.existsSync(ALIAS_FILE)
    ? JSON.parse(fs.readFileSync(ALIAS_FILE, 'utf8')) : {};
const usedPorts = new Set();

// =========================
// 輔助函式：Port 管理
// =========================
function allocPort() {
    for (let p = 27183; p < 28000; p++) {
        if (!usedPorts.has(p)) {
            usedPorts.add(p);
            return p;
        }
    }
    throw new Error('No available ports');
}
function freePort(p) { usedPorts.delete(p); }

// =========================
// Express 伺服器
// =========================
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 取得裝置列表
app.get('/api/devices', async (req, res) => {
    const devices = await getAdbDevices();
    res.json(devices.map(d => ({
        serial: d.serial,
        model: d.model,
        alias: deviceAliases[d.serial] || '',
        status: activeClients.has(d.serial) ? 'running' : 'stopped'
    })));
});

// =========================
// WebSocket 伺服器
// =========================
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', async (ws, req) => {
    const params = new URLSearchParams(req.url.replace('/?', ''));
    const serial = params.get('serial');

    if (!serial || !deviceBuffers.has(serial)) {
        ws.close(1008, 'Invalid serial');
        return;
    }

    ws.serial = serial;
    console.log(`WS connected -> ${serial}`);
    const target = activeClients.get(serial);
    // if (!target || !target.client) return;
    // await target.client.wakeScreen();
    // 1. 補發影像標頭 (SPS/PPS/IDR)
    const buf = deviceBuffers.get(serial);
    if (buf.sps) ws.send(buf.sps);
    if (buf.pps) ws.send(buf.pps);
    if (buf.idr) ws.send(buf.idr);
    // 2. 初始狀態回報 (電源狀態 & 裝置型號)
    sendPowerStatus(ws, target.client);
    target.client.getDeviceDetails().then(info => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(Buffer.from(JSON.stringify({
                type: 'info',
                model: info.model,
                version: info.version
            })));
        }
    });

    // 3. 狀態輪詢 (Heartbeat) - 每 2 秒檢查一次手機是否休眠
    const statusInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            const currentTarget = activeClients.get(serial);
            if (currentTarget?.client) {
                sendPowerStatus(ws, currentTarget.client);
            }
        } else {
            clearInterval(statusInterval);
        }
    }, 2000);

    // 4. 訊息處理
    ws.on('message', async (message) => {
        try {
            const msg = JSON.parse(message);
            const currentTarget = activeClients.get(serial);
            if (!currentTarget?.client) return;
            switch (msg.type) {
                case 'wake':
                    await currentTarget.client.wakeScreen();
                    setTimeout(() => sendPowerStatus(ws, currentTarget.client), 500);
                    break;
                case 'touch':
                    currentTarget.client.sendTouch(msg.action, msg.x, msg.y);
                    break;
                case 'key':
                    currentTarget.client.sendKey(msg.keycode);
                    // 若按電源或 Home 鍵，立即更新狀態
                    if (msg.keycode === 26 || msg.keycode === 3) {
                        setTimeout(() => sendPowerStatus(ws, currentTarget.client), 1000);
                    }
                    break;
                // case 'text': // 保留文字輸入 (支援鍵盤直接打字)
                //     currentTarget.client.sendText(msg.text);
                //     break;
            }
        } catch (e) {
            console.error('WS Message Error:', e);
        }
    });

    ws.on('close', async () => {
        console.log(`WS closed -> ${serial}`);
        const currentTarget = activeClients.get(serial);
        if (currentTarget?.client) {
            // 必須透過 .client 呼叫
            await currentTarget.client.setScreenPower(false);
            console.log(`[${serial}] 已觸發斷線自動關閉螢幕`);
        }
        clearInterval(statusInterval);
    });
});

// =========================
// 核心功能與工具
// =========================

// 狀態回報 (封裝成 Buffer 發送)
async function sendPowerStatus(ws, client) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
        const output = await client.runAdbCommand('shell', 'dumpsys', 'power');
        const isAwake = output.includes('mWakefulness=Awake');
        ws.send(Buffer.from(JSON.stringify({
            type: 'status',
            wakeState: isAwake ? 'Awake' : 'Asleep'
        })));
    } catch (e) {
        console.error(`Status check failed for ${client.serial}:`, e.message);
    }
}

// 影像廣播
function broadcast(serial, data) {
    wss.clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN && ws.serial === serial) {
            ws.send(data);
        }
    });
}

// NAL 緩存 (用於秒開畫面)
function cacheNal(serial, buf) {
    const nalType = buf[4] & 0x1f;
    const cache = deviceBuffers.get(serial);
    if (!cache) return;
    if (nalType === 7) cache.sps = buf;
    else if (nalType === 8) cache.pps = buf;
    else if (nalType === 5) cache.idr = buf;
}

// =========================
// 裝置掃描器 (自動發現與回收)
// =========================
let scanning = false;
async function deviceScanner() {
    if (scanning) return;
    scanning = true;

    try {
        const devices = await getAdbDevices();
        const currentSerials = new Set(devices.map(d => d.serial));

        // 移除斷線裝置
        for (const [serial, info] of activeClients) {
            if (!currentSerials.has(serial)) {
                console.log(`[${serial}] Device disconnected/removed`);
                if (info.client.stop) info.client.stop();
                freePort(info.port);
                activeClients.delete(serial);
                deviceBuffers.delete(serial);
            }
        }

        // 新增裝置
        for (const d of devices) {
            if (activeClients.has(d.serial)) continue;

            const port = allocPort();
            console.log(`[${d.serial}] Found new device, starting on port ${port}`);

            const client = new ScrcpyClient(d.serial, { port, baseDir: exeDir });
            activeClients.set(d.serial, { client, port });
            deviceBuffers.set(d.serial, {});

            client.on('video-data', data => {
                cacheNal(d.serial, data);
                broadcast(d.serial, data);
            });

            client.on('error', e => console.error(`[${d.serial}] Client error:`, e));
            client.start();
        }
    } catch (e) {
        console.error('Scanner loop error:', e);
    } finally {
        scanning = false;
    }
}

// 啟動掃描與伺服器
setInterval(deviceScanner, 3000);
deviceScanner();

server.listen(PORT, () => {
    console.log(`===========================================`);
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`Logs are stored in: ${LOG_DIR}`);
    console.log(`===========================================`);
});

// =========================
// ADB 執行緒
// =========================
function getAdbDevices() {
    return new Promise(resolve => {
        const adbPath = path.join(exeDir, 'vendor', 'adb.exe');
        const adb = spawn(adbPath, ['devices', '-l']);
        let out = '';
        adb.stdout.on('data', d => out += d);
        adb.on('close', () => {
            const lines = out.split('\n').filter(l => l.includes('device') && !l.startsWith('List'));
            resolve(lines.map(l => {
                const parts = l.split(/\s+/);
                const model = parts.find(x => x.startsWith('model:'));
                return {
                    serial: parts[0],
                    model: model ? model.split(':')[1] : 'Unknown'
                };
            }));
        });
        adb.on('error', (e) => {
            console.error('Failed to spawn ADB:', e);
            resolve([]);
        });
    });
}