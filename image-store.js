const IMAGE_DB_NAME = 'seedance-image-store';
const IMAGE_DB_VERSION = 1;
const IMAGE_STORE_NAME = 'images';

let imageDbPromise = null;

function openImageDb() {
  if (imageDbPromise) {
    return imageDbPromise;
  }

  imageDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(IMAGE_DB_NAME, IMAGE_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IMAGE_STORE_NAME)) {
        const store = db.createObjectStore(IMAGE_STORE_NAME, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开图片数据库失败'));
  });

  return imageDbPromise;
}

function runImageTransaction(mode, handler) {
  return openImageDb().then((db) => new Promise((resolve, reject) => {
    const transaction = db.transaction(IMAGE_STORE_NAME, mode);
    const store = transaction.objectStore(IMAGE_STORE_NAME);

    let result;
    try {
      result = handler(store, transaction);
    } catch (error) {
      reject(error);
      return;
    }

    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error('图片数据库事务失败'));
    transaction.onabort = () => reject(transaction.error || new Error('图片数据库事务已中止'));
  }));
}

export async function putImageRecord(record) {
  if (!record?.id) {
    throw new Error('缺少图片 ID');
  }

  await runImageTransaction('readwrite', (store) => {
    store.put({
      ...record,
      updatedAt: Date.now()
    });
  });

  return record.id;
}

export function getImageRecord(id) {
  if (!id) {
    return Promise.resolve(null);
  }

  return runImageTransaction('readonly', (store) => new Promise((resolve, reject) => {
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('读取图片失败'));
  }));
}

export async function getImageBlob(id) {
  const record = await getImageRecord(id);
  return record?.blob || null;
}

export async function deleteImageRecords(ids) {
  const validIds = Array.from(new Set((ids || []).filter(Boolean)));
  if (validIds.length === 0) {
    return;
  }

  await runImageTransaction('readwrite', (store) => {
    validIds.forEach((id) => store.delete(id));
  });
}
