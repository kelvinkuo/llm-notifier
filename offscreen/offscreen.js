// offscreen/offscreen.js

const audio = document.getElementById('notification-sound');

// 监听播放结束事件
audio.onended = () => {
    // 播放完毕，关闭这个 offscreen 页面
    window.close();
};

// 备用：万一自动播放失败（虽然不应该），尝试手动播放
audio.play().catch(e => {
    console.error("Offscreen audio error:", e);
    // 即使出错也关闭
    window.close();
});