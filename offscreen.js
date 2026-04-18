const audio = document.getElementById('notificationSound');

async function playSound() {
  if (!audio) {
    return;
  }

  try {
    audio.pause();
    audio.currentTime = 0;
    await audio.play();
  } catch (error) {
    console.error('播放失败:', error);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'OFFSCREEN_PLAY_SOUND') {
    return false;
  }

  playSound()
    .then(() => sendResponse({ success: true }))
    .catch((error) => sendResponse({ success: false, error: error.message }));

  return true;
});

playSound();
