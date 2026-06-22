import { supabase } from '../lib/supabase.js';
import { withTenant } from '../db/pool.js';

const BUCKET = 'payment-approvals';
const SIGNED_URL_EXPIRY_SECONDS = 60 * 60 * 24 * 365; // 1 year

/**
 * Upload a payment approval photo to private Supabase Storage,
 * generate a 1-year signed URL, and store it on the payment row.
 *
 * Path: {gymId}/payment-approvals/{paymentId}.jpg
 * Returns the signed URL that was stored.
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

  const { data: signed, error: signErr } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_URL_EXPIRY_SECONDS);

  if (signErr || !signed?.signedUrl) {
    throw new Error(`Signed URL generation failed: ${signErr?.message ?? 'no URL returned'}`);
  }

  // Persist the URL on the payment row (scoped to the gym via withTenant / RLS)
  await withTenant(gymId, async (client) => {
    await client.query(
      `UPDATE payments SET approver_photo_url = $1 WHERE id = $2`,
      [signed.signedUrl, paymentId],
    );
  });

  return signed.signedUrl;
}
