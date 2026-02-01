const net = require('net');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const path = require('path');

// --- 常數定義 ---
const CONSTANTS = {
    DEFAULT_VERSION: '3.3.4',
    DEFAULT_SERVER_PATH: '/data/local/tmp/scrcpy-server.jar',
    // Protocol Offsets & Sizes
    HEADER_SIZE: 76,
    DEVICE_NAME_FIELD_LENGTH: 64,
    PACKET_META_SIZE: 12,
    // Input Event Types
    ACTION_DOWN: 0,
    ACTION_UP: 1,
    KEY_EVENT_WAKE: 224,
    KEY_EVENT_SLEEP: 223,
};

class ScrcpyClient extends EventEmitter {
    constructor(serial, options = {}) {
        super();
        this.serial = serial;
        this.port = options.port;

        const baseDir = options.baseDir || __dirname;
        this.adbPath = path.join(baseDir, 'vendor', 'adb.exe');
        this.serverJarPath = path.join(baseDir, 'vendor', 'scrcpy-server.jar');

        this.version = options.version || CONSTANTS.DEFAULT_VERSION;
        this.deviceServerPath = options.serverPath || CONSTANTS.DEFAULT_SERVER_PATH;

        // 效能相關設定
        this.maxSize = options.maxSize || 1024;       // 降低解析度以提升效能 (原 1024)
        this.bitrate = options.bitrate || 1000000;   // 2Mbps
        this.maxFps = options.maxFps || 60;

        this.localServer = null;
        this.adbProcess = null;
        this.socket = null;

        this.buffer = Buffer.alloc(0);
        this.readState = 'HEADER';
        this.streamState = 'PACKET_META';
        this.currentPacketSize = 0;

        this.deviceInfo = { width: 0, height: 0, name: '' };
    }

    async start() {
        try {
            this._log(`Initialization... (Port: ${this.port})`);
            await this.runAdb(['reverse', '--remove-all']);
            await this._setupLocalServer();
            await this.runAdb(['push', this.serverJarPath, this.deviceServerPath]);
            await this.runAdb(['reverse', 'localabstract:scrcpy', `tcp:${this.port}`]);

            await new Promise(r => setTimeout(r, 500));
            this._log('Spawning Scrcpy server process...');
            this._spawnServerProcess();

        } catch (error) {
            console.error(`[${this.serial}] Start failed:`, error);
            this.emit('error', error);
            this.stop();
        }
    }

    _setupLocalServer() {
        return new Promise((resolve, reject) => {
            if (this.localServer) this.localServer.close();

            this.localServer = net.createServer((socket) => {
                this._log('TCP Socket connected');
                this.socket = socket;

                // 關鍵：停用 Nagle 演算法，減少延遲
                socket.setNoDelay(true);

                socket.on('data', (chunk) => this._processData(chunk));

                socket.on('close', () => {
                    this._log('TCP Socket closed');
                    this.emit('disconnected');
                });
                socket.on('error', (err) => {
                    console.error(`[${this.serial}] Socket error:`, err);
                    this.emit('error', err);
                });
            });

            this.localServer.listen(this.port, '0.0.0.0', () => resolve());
            this.localServer.on('error', (err) => reject(new Error(`Port ${this.port} error: ${err.message}`)));
        });
    }

    /**
     * [高效能版] 資料處理函式
     * 使用 Offset 指標移動，而非頻繁切割 Buffer
     */
    _processData(chunk) {
        // 只有當 buffer 有剩餘資料時才進行 concat，否則直接使用 chunk，減少記憶體複製
        if (this.buffer.length > 0) {
            this.buffer = Buffer.concat([this.buffer, chunk]);
        } else {
            this.buffer = chunk;
        }

        let offset = 0;
        let remaining = this.buffer.length;

        // 使用迴圈盡可能一次處理完 Buffer 內所有完整的封包
        while (remaining > 0) {
            if (this.readState === 'HEADER') {
                if (remaining < CONSTANTS.HEADER_SIZE) break;

                // 解析 Header (使用 subarray 建立視圖，不複製記憶體)
                const nameBytes = this.buffer.subarray(offset, offset + CONSTANTS.DEVICE_NAME_FIELD_LENGTH);
                const name = nameBytes.toString('utf8').replace(/\0/g, '');

                // 讀取寬高 (Offset 分別為 68, 72)
                const width = this.buffer.readUInt32BE(offset + 68);
                const height = this.buffer.readUInt32BE(offset + 72);

                this.deviceInfo = { name, width, height };
                this._log(`Device Header Received: ${name}, ${width}x${height}`);
                this.emit('ready', this.deviceInfo);

                // 移動指針
                offset += CONSTANTS.HEADER_SIZE;
                remaining -= CONSTANTS.HEADER_SIZE;
                this.readState = 'STREAMING';
            }
            else if (this.readState === 'STREAMING') {
                if (this.streamState === 'PACKET_META') {
                    if (remaining < CONSTANTS.PACKET_META_SIZE) break;

                    // 讀取 PTS (前8 bytes) - 這裡我們通常忽略 Presentation Time Stamp
                    // 讀取 Packet Size (Offset 8)
                    this.currentPacketSize = this.buffer.readUInt32BE(offset + 8);

                    offset += CONSTANTS.PACKET_META_SIZE;
                    remaining -= CONSTANTS.PACKET_META_SIZE;
                    this.streamState = 'PACKET_DATA';
                }
                else if (this.streamState === 'PACKET_DATA') {
                    if (remaining < this.currentPacketSize) break;

                    // 只有在這裡需要發送資料出去
                    // subarray 是 zero-copy view，非常快
                    const videoData = this.buffer.subarray(offset, offset + this.currentPacketSize);
                    this.emit('video-data', videoData);

                    offset += this.currentPacketSize;
                    remaining -= this.currentPacketSize;
                    this.streamState = 'PACKET_META';
                }
            }
        }

        // --- 清理階段 ---
        // 如果 offset 已經移動到末端，直接清空 buffer
        if (offset === this.buffer.length) {
            this.buffer = Buffer.alloc(0);
        }
        // 否則，只保留未處理的部分 (這是唯一的必要記憶體操作)
        else if (offset > 0) {
            // 注意：這裡使用 subarray 雖然快，但若原始 buffer 很大，會導致記憶體無法釋放。
            // 為了避免記憶體破碎化，當處理掉大部分資料時，可以用 Buffer.from 進行深拷貝整理 (視情況而定)。
            // 在高頻串流中，直接 subarray 通常是權衡後的最佳解。
            this.buffer = this.buffer.subarray(offset);
        }
    }

    _getServerArgs() {
        // 優化參數配置
        return [
            'shell', 'app_process',
            `-Djava.class.path=${this.deviceServerPath}`,
            '/', 'com.genymobile.scrcpy.Server',
            this.version,
            'log_level=info', // 改為 info 減少 verbose log 的 I/O 消耗
            'tunnel_forward=false',
            'control=true',
            'audio=false', // 確保關閉音訊
            `max_size=${this.maxSize}`, // [優化] 限制解析度 (例如 800)
            `max_fps=${this.maxFps}`,
            `video_bitrate=${this.bitrate}`, // [優化] 限制 Bitrate
            'i-frame-interval=2', // 關鍵幀間隔
            'codec_options=profile=1', // Baseline profile, 解碼負擔較低
            // 若設備支援 H.265，可嘗試加入 'video_codec=h265'
        ];
    }

    _spawnServerProcess() {
        const args = this._getServerArgs();
        this.adbProcess = spawn(this.adbPath, ['-s', this.serial, ...args]);

        this.adbProcess.stdout.on('data', d => {
            // 可選：若不需要 debug，可註解掉這行以節省 console I/O
            // console.log(`[${this.serial} Internal]: ${d.toString().trim()}`);
        });

        this.adbProcess.on('close', (code) => {
            this._log(`Scrcpy process exited with code ${code}`);
            this.stop();
        });
    }

    // --- ADB Helpers (維持不變) ---
    runAdb(args) {
        return new Promise((resolve, reject) => {
            const cmd = spawn(this.adbPath, ['-s', this.serial, ...args]);
            cmd.on('close', code => code === 0 ? resolve() : reject(new Error(`ADB Fail: ${args.join(' ')}`)));
            cmd.on('error', reject);
        });
    }

    runAdbCommand(...args) {
        return new Promise((resolve, reject) => {
            const cmd = spawn(this.adbPath, ['-s', this.serial, ...args]);
            let out = '';
            cmd.stdout.on('data', d => out += d.toString());
            cmd.on('close', code => code === 0 ? resolve(out) : resolve(''));
            cmd.on('error', reject);
        });
    }

    // --- Control Features (維持不變) ---
    async wakeScreen() {
        try {
            const output = await this.runAdbCommand('shell', 'dumpsys', 'power');
            if (output.includes('mWakefulness=Asleep')) {
                await this.sendKey(CONSTANTS.KEY_EVENT_WAKE);
            } else {
                await this.sendKey(CONSTANTS.KEY_EVENT_SLEEP);
            }
        } catch (e) { console.error(e); }
    }

    sendKey(keycode) {
        this.runAdb(['shell', 'input', 'keyevent', keycode]).catch(console.error);
    }

    sendText(text) {
        if (!text) return;
        let safeText = text.replace(/\s/g, '%s').replace(/'/g, "\\'").replace(/"/g, '\\"');
        this.runAdb(['shell', 'input', 'text', `'${safeText}'`]).catch(console.error);
    }

    sendTouch(action, xPercent, yPercent) {
        if (!this.socket || !this.deviceInfo.width) return;
        const x = Math.round(xPercent * this.deviceInfo.width);
        const y = Math.round(yPercent * this.deviceInfo.height);
        const buffer = Buffer.alloc(32);
        buffer.writeUInt8(2, 0);
        buffer.writeUInt8(action, 1);
        buffer.writeInt32BE(x, 10);
        buffer.writeInt32BE(y, 14);
        buffer.writeUInt16BE(this.deviceInfo.width, 18);
        buffer.writeUInt16BE(this.deviceInfo.height, 20);
        buffer.writeUInt16BE(action === 1 ? 0 : 65535, 22);
        buffer.writeUInt32BE(1, 24);
        buffer.writeInt32BE(0, 28);
        try { this.socket.write(buffer); } catch (e) { console.error(e); }
    }

    async getDeviceDetails() {
        try {
            const [manufacturer, model, brand, marketName, version] = await Promise.all([
                this.runAdbCommand('shell', 'getprop', 'ro.product.manufacturer'),
                this.runAdbCommand('shell', 'getprop', 'ro.product.model'),
                this.runAdbCommand('shell', 'getprop', 'ro.product.brand'),
                this.runAdbCommand('shell', 'getprop', 'ro.product.marketname'),
                this.runAdbCommand('shell', 'getprop', 'ro.build.version.release')
            ]).then(results => results.map(r => r.trim()));

            let finalName = model;
            if (marketName) finalName = marketName;
            else if (brand && model.toLowerCase().startsWith(brand.toLowerCase())) finalName = model;
            else if (brand) finalName = `${brand} ${model}`;
            else if (manufacturer) finalName = `${manufacturer} ${model}`;

            return { model: finalName, version: `Android ${version}` };
        } catch (e) {
            console.error(`[${this.serial}] Failed to get details:`, e);
            return { model: 'Unknown', version: 'Unknown' };
        }
    }
    async setScreenPower(turnOn) {
        try {
            const output = await this.runAdbCommand('shell', 'dumpsys', 'power');
            const isAwake = output.includes('mWakefulness=Awake');

            if (turnOn && !isAwake) {
                await this.runAdb(['shell', 'input', 'keyevent', '224']); // WAKEUP
            } else if (!turnOn && isAwake) {
                await this.runAdb(['shell', 'input', 'keyevent', '223']);    // SLEEP
            }
        } catch (e) {
            console.error(`[${this.serial}] Power switch failed:`, e.message);
        }
    }
    stop() {
        if (this.socket) { this.socket.destroy(); this.socket = null; }
        if (this.localServer) { this.localServer.close(); this.localServer = null; }
        if (this.adbProcess) { try { this.adbProcess.kill(); } catch (e) { } this.adbProcess = null; }
        this.emit('stopped');
    }

    _log(msg) {
        console.log(`[${this.serial}] ${msg}`);
    }
}

module.exports = ScrcpyClient;