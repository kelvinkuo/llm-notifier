import { createLogger } from "../shared/logger.js";

const logger = createLogger("Offscreen");
logger.info("Offscreen 页面已加载。", {
    time: new Date().toISOString(),
});

const audio = document.getElementById('notification-sound');
if (!audio) {
    logger.error("未找到 audio 元素，准备关闭 offscreen 页面。");
    logger.info("正在关闭 offscreen 页面。", {
        reason: "audio-element-not-found",
    });
    window.close();
} else {
    logger.debug("已找到 audio 元素。", {
        id: audio.id,
        src: audio.currentSrc || audio.src,
    });

    audio.onended = () => {
        logger.info("音频播放结束（audio ended）。");
        logger.info("正在关闭 offscreen 页面。", {
            reason: "audio-ended",
        });
        window.close();
    };

    logger.debug("正在调用 audio.play()。");
    audio.play()
        .then(() => {
            logger.info("audio.play() Promise 成功。");
        })
        .catch((error) => {
            logger.error("audio.play() 失败。", error);
            logger.info("正在关闭 offscreen 页面。", {
                reason: "audio-play-failed",
            });
            window.close();
        });
}
