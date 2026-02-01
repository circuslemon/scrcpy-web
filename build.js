const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// 設定路徑
const rootDir = __dirname;
const distDir = path.join(rootDir, 'dist');
const vendorSrc = path.join(rootDir, 'vendor');
const vendorDest = path.join(distDir, 'vendor');

console.log('🚀 開始構建流程...');

// 1. 清理舊的 dist 資料夾
if (fs.existsSync(distDir)) {
    console.log('🧹 清理舊的 dist 資料夾...');
    fs.rmSync(distDir, { recursive: true, force: true });
}
// 建立新的 dist 資料夾
fs.mkdirSync(distDir);

// 2. 執行 pkg 打包
console.log('📦 正在執行 pkg 打包 (這可能需要一點時間)...');
try {
    // 這裡會執行 package.json 裡的 pkg 設定
    // 注意：--public-packages "*" 是為了確保某些依賴能正確被打包 (選用)
    execSync('pkg . --targets node18-win-x64 --output dist/scrcpy-control.exe', { stdio: 'inherit' });
} catch (error) {
    console.error('❌ 打包失敗，請檢查 pkg 設定。');
    process.exit(1);
}

// 3. 複製 vendor 資料夾
console.log('📂 正在複製 vendor 資料夾...');
if (fs.existsSync(vendorSrc)) {
    // 遞迴複製整個資料夾 (Node.js 16.7+ 支援 cpSync)
    fs.cpSync(vendorSrc, vendorDest, { recursive: true });
} else {
    console.warn('⚠️ 警告：找不到 vendor 資料夾，請確認它是否存在於根目錄！');
}

// 4. (選用) 如果有預設的別名檔，也可以順便複製
const aliasFile = path.join(rootDir, 'device_aliases.json');
if (fs.existsSync(aliasFile)) {
    console.log('📄 複製 device_aliases.json...');
    fs.copyFileSync(aliasFile, path.join(distDir, 'device_aliases.json'));
}

console.log('✅ 構建完成！');
console.log(`👉 請查看: ${distDir}`);