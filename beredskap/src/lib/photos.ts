import { supabase } from './supabase';
import type { DraftPhoto } from './drafts';

const MAX_SIDE = 1600;
const QUALITY = 0.82;

/**
 * Turns a camera photo into a smaller JPEG on the device. Drawing it through
 * a canvas applies the orientation and drops all metadata, including GPS
 * coordinates, before anything leaves the phone. The server strips it again.
 */
export async function prepareImage(file: File): Promise<{ blob: Blob; width: number; height: number }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode image'))), 'image/jpeg', QUALITY),
  );
  return { blob, width, height };
}

export class UploadError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function uploadPhoto(photo: DraftPhoto, shelterId: string, context: 'self_check' | 'maintenance'): Promise<void> {
  const { data } = await supabase.auth.getSession();
  if (!data.session) throw new UploadError(401, 'not signed in');

  const q = new URLSearchParams({
    photo_id: photo.id,
    shelter_id: shelterId,
    context,
    context_id: photo.draftId,
    item_key: photo.itemKey,
  });
  let res: Response;
  try {
    res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/upload-photo?${q}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${data.session.access_token}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        'Content-Type': 'image/jpeg',
      },
      body: photo.blob,
    });
  } catch {
    throw new UploadError(0, 'offline');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new UploadError(res.status, body.error ?? res.statusText);
  }
}

/** Short-lived links (5 minutes) for photos the user is allowed to see. */
export async function signedUrls(paths: string[], seconds = 300): Promise<Record<string, string>> {
  if (!paths.length) return {};
  const { data, error } = await supabase.storage.from('photos').createSignedUrls(paths, seconds);
  if (error) throw error;
  return Object.fromEntries((data ?? []).filter((d) => d.signedUrl && d.path).map((d) => [d.path!, d.signedUrl as string]));
}
