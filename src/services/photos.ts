import { env } from '../config/env.js';
import { supabase } from '../lib/supabase.js';
import { HttpError } from '../utils/errors.js';

/** mimetype -> allowed. Matches the bucket's `allowed_mime_types`. */
export const ALLOWED_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

export function assertValidPhoto(mimetype: string, size: number): void {
  if (!ALLOWED_PHOTO_TYPES.has(mimetype)) {
    throw new HttpError(415, 'Photo must be a JPEG, PNG, or WEBP image');
  }
  if (size > MAX_PHOTO_BYTES) {
    throw new HttpError(413, 'Photo must be 5MB or smaller');
  }
}

/**
 * Uploads a member's profile photo to a fixed path
 * (`{gym_id}/{member_id}/profile`) with `upsert: true`, so a re-upload
 * replaces the previous photo at the same path automatically.
 *
 * Returns the public URL with a cache-busting `?v=` query param — the
 * storage path never changes, so without it the browser/CDN would keep
 * serving the old image after an upload.
 */
export async function uploadMemberPhoto(
  gymId: string,
  memberId: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  const path = `${gymId}/${memberId}/profile`;

  const { error } = await supabase.storage
    .from(env.SUPABASE_STORAGE_BUCKET)
    .upload(path, buffer, { contentType, upsert: true });

  if (error) {
    throw new HttpError(502, `Photo upload failed: ${error.message}`);
  }

  const { data } = supabase.storage.from(env.SUPABASE_STORAGE_BUCKET).getPublicUrl(path);
  return `${data.publicUrl}?v=${Date.now()}`;
}
