self.addEventListener('message', async (event) => {
  const {
    id,
    file,
    maxStoredEdge,
    maxThumbEdge,
    storedType,
    storedQuality,
    thumbType,
    thumbQuality
  } = event.data || {};

  try {
    if (!(file instanceof Blob)) {
      throw new Error('无效的图片文件');
    }

    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') {
      throw new Error('当前环境不支持后台图片处理');
    }

    const bitmap = await createImageBitmap(file);

    try {
      const stored = await renderBitmap(bitmap, maxStoredEdge, storedType, storedQuality);
      const thumb = await renderBitmap(bitmap, maxThumbEdge, thumbType, thumbQuality);

      self.postMessage({
        id,
        success: true,
        storedBlob: stored.blob,
        thumbBlob: thumb.blob,
        width: stored.width,
        height: stored.height
      });
    } finally {
      if (typeof bitmap.close === 'function') {
        bitmap.close();
      }
    }
  } catch (error) {
    self.postMessage({
      id,
      success: false,
      error: error?.message || '图片处理失败'
    });
  }
});

async function renderBitmap(bitmap, maxEdge, type, quality) {
  const { width, height } = fitSize(bitmap.width, bitmap.height, maxEdge);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { alpha: true });

  if (!context) {
    throw new Error('无法创建离屏画布');
  }

  context.drawImage(bitmap, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type, quality });

  canvas.width = 1;
  canvas.height = 1;

  return {
    blob,
    width,
    height
  };
}

function fitSize(width, height, maxEdge) {
  if (!width || !height || Math.max(width, height) <= maxEdge) {
    return { width: width || 1, height: height || 1 };
  }

  const scale = maxEdge / Math.max(width, height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}
