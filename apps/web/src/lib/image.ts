/**
 * Photos are shrunk in the browser before upload (docs/09, 2026-11-01 "Scans"): the Worker never decodes images,
 * and 2400 px on the long edge keeps small print in listings readable for the model.
 */
const MAX_EDGE = 2400;

export async function shrinkPhoto(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('This browser cannot open that image. Try a JPG or PNG, or a screenshot of it.');
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
  if (!blob) throw new Error('Could not prepare the photo.');
  return blob;
}

/** The day the photo was taken (file date), so "Wed 4" on an older magazine page means that month. */
export const photoDay = (file: File) =>
  file.lastModified ? new Date(file.lastModified).toISOString().slice(0, 10) : undefined;
