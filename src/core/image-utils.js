/**
 * Screenshots are shrunk before they are sent anywhere. A 4K PNG is several
 * megabytes of base64; a 1600 px JPEG is a few hundred kilobytes and reads
 * just as well for text, so uploads are faster and cheaper and carry less.
 * Uses Electron's nativeImage; outside Electron the image is returned as is.
 */
const MAX_EDGE = 1600;
const JPEG_QUALITY = 80;
const TOO_BIG_BYTES = 6 * 1024 * 1024;

function nativeImageApi() {
  try {
    const electron = require('electron');
    return electron && electron.nativeImage && typeof electron.nativeImage.createFromBuffer === 'function'
      ? electron.nativeImage
      : null;
  } catch (_) {
    return null;
  }
}

/**
 * @param {Buffer} buffer PNG or JPEG bytes
 * @returns {{buffer: Buffer, mimeType: string, width?: number, height?: number, shrunk: boolean}}
 */
function shrinkImage(buffer, mimeType = 'image/png', { maxEdge = MAX_EDGE, quality = JPEG_QUALITY } = {}) {
  const unchanged = { buffer, mimeType, shrunk: false };
  const api = nativeImageApi();
  if (!api || !Buffer.isBuffer(buffer) || !buffer.length) return unchanged;
  try {
    let image = api.createFromBuffer(buffer);
    if (image.isEmpty()) return unchanged;
    const { width, height } = image.getSize();
    const longest = Math.max(width, height);
    if (longest > maxEdge) {
      const scale = maxEdge / longest;
      image = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' });
    }
    const jpeg = image.toJPEG(quality);
    // Keep the original when re-encoding did not help (small, already compact images).
    if (jpeg.length >= buffer.length && buffer.length < TOO_BIG_BYTES) return unchanged;
    const size = image.getSize();
    return { buffer: jpeg, mimeType: 'image/jpeg', width: size.width, height: size.height, shrunk: true };
  } catch (_) {
    return unchanged;
  }
}

module.exports = { shrinkImage, MAX_EDGE };
