import { supabase } from '../lib/supabase.js';
import { withTenant } from '../db/pool.js';

const BUCKET = 'payment-approvals';
const SIGNED_URL_EXPIRY_SECONDS = 3600; // 1 hour — regenerated on every list request

/**
 * Upload a payment approval photo to private Supabase Storage and store
 * the STORAGE PATH (not a signed URL) on the payment row.
 *
 * Storing the path means the DB value never expires. Fresh signed URLs are
 * generated at read-time by batchSignPhotoUrls() in the list endpoints.
 *
 * Path format: {gymId}/payment-approvals/{paymentId}.jpg
 * Returns the storage path that was persisted.
 */
export async function uploadPaymentApprovalPhoto(
  gymId: string,
  paymentId: string,
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  const path = `${gymId}/payment-approvals/${paymentId}.jpg`;

  const { error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType: mimeType, upsert: true });

  if (uploadErr) {
    throw new Error(`Approval photo upload failed: ${uploadErr.message}`);
  }

  // Store the durable storage PATH — not a signed URL — so the record never expires.
  await withTenant(gymId, async (client) => {
    await client.query(
      `UPDATE payments SET approver_photo_url = $1 WHERE id = $2`,
      [path, paymentId],
    );
  });

  return path;
}

/**
 * Generate a single fresh signed URL for one storage path.
 * Used by the upload route to return an immediately-usable URL to the caller.
 */
export async function generateSignedUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_EXPIRY_SECONDS);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

/**
 * Batch-generate 1-hour signed URLs for an array of storage paths.
 * Returns a Map<path, signedUrl> — missing paths silently get no entry.
 * Used by listPayments / listMemberPayments to sign every photo in one round-trip.
 */
export async function batchSignPhotoUrls(
  paths: (string | null)[],
): Promise<Map<string, string>> {
  const nonNull = paths.filter((p): p is string => p !== null);
  if (nonNull.length === 0) return new Map();

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(nonNull, SIGNED_URL_EXPIRY_SECONDS);

  if (error) {
    // Non-fatal — degrade gracefully; photos will just not render.
    console.error('batchSignPhotoUrls failed:', error.message);
    return new Map();
  }

  const map = new Map<string, string>();
  for (const item of data ?? []) {
    if (item.signedUrl && item.path) map.set(item.path, item.signedUrl);
  }
  return map;
}
