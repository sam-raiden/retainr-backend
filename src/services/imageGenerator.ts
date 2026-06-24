import sharp from 'sharp';

const W = 800;             // fixed image width
const PAD = 32;            // horizontal padding
const ROW_H = 40;          // data row height
const SEC_H = 48;          // section header bar height
const COL_H = 30;          // column header bar height
const MAX_PER_SECTION = 30;

// Colours
const C_BG       = '#0D0D12';
const C_ROW_ALT  = '#13131f';
const C_ORANGE   = '#f97316';
const C_RED      = '#ef4444';
const C_WHITE    = '#f4f4f5';
const C_GREY     = '#71717a';
const C_BORDER   = '#27272a';
const C_COL_EXP  = '#1e1208';  // dark tint for expiring col-header
const C_COL_DEAD = '#1e0a0a';  // dark tint for expired  col-header

// Column X positions (must sum to W − 2×PAD = 736)
const COL = {
  name:  { x: PAD,        w: 230 },
  plan:  { x: PAD + 230,  w: 140 },
  amt:   { x: PAD + 370,  w: 116 },
  phone: { x: PAD + 486,  w: 218 },
};

export interface SummaryMember {
  name: string;
  plan: string;
  price: number | null;
  phone: string;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function x(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c,
  );
}

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function rect(x2: number, y: number, w: number, h: number, fill: string, rx = 0) {
  return `<rect x="${x2}" y="${y}" width="${w}" height="${h}" fill="${fill}" rx="${rx}"/>`;
}

function txt(
  cx: number, y: number, content: string,
  { size = 13, fill = C_WHITE, anchor = 'start', bold = false }: {
    size?: number; fill?: string; anchor?: 'start' | 'middle' | 'end'; bold?: boolean;
  } = {},
) {
  const weight = bold ? ' font-weight="bold"' : '';
  return `<text x="${cx}" y="${y}" font-family="Arial,Helvetica,sans-serif" font-size="${size}"${weight} fill="${fill}" text-anchor="${anchor}">${content}</text>`;
}

// ── row builder ──────────────────────────────────────────────────────────────

function buildRows(members: SummaryMember[], startY: number): { svg: string; h: number } {
  const visible = members.slice(0, MAX_PER_SECTION);
  const extra   = members.length - visible.length;
  let svg = '';
  let y   = startY;

  for (let i = 0; i < visible.length; i++) {
    const m   = visible[i]!;
    const bg  = i % 2 === 0 ? C_BG : C_ROW_ALT;
    const mid = y + ROW_H / 2 + 5;          // vertical text baseline

    svg += rect(0, y, W, ROW_H, bg);
    // subtle bottom divider
    svg += rect(PAD, y + ROW_H - 1, W - PAD * 2, 1, C_BORDER);
    svg += txt(COL.name.x,  mid, x(trunc(m.name, 26)));
    svg += txt(COL.plan.x,  mid, x(trunc(m.plan, 17)), { size: 12, fill: C_GREY });
    svg += txt(COL.amt.x,   mid, `Rs.${x(String(m.price ?? '?'))}`, { size: 12, fill: C_ORANGE });
    svg += txt(COL.phone.x, mid, x(m.phone), { size: 12, fill: C_GREY });
    y += ROW_H;
  }

  if (extra > 0) {
    svg += rect(0, y, W, ROW_H, C_ROW_ALT);
    svg += txt(W / 2, y + ROW_H / 2 + 5, `...and ${extra} more members`,
      { size: 12, fill: C_GREY, anchor: 'middle' });
    y += ROW_H;
  }

  return { svg, h: y - startY };
}

function buildEmpty(startY: number, msg: string): { svg: string; h: number } {
  return {
    svg: rect(0, startY, W, ROW_H, C_ROW_ALT)
       + txt(W / 2, startY + ROW_H / 2 + 5, x(msg), { size: 13, fill: C_GREY, anchor: 'middle' }),
    h: ROW_H,
  };
}

function buildColHeaders(startY: number, tint: string): string {
  return rect(0, startY, W, COL_H, tint)
    + txt(COL.name.x,  startY + COL_H / 2 + 4, 'NAME',   { size: 11, fill: C_GREY, bold: true })
    + txt(COL.plan.x,  startY + COL_H / 2 + 4, 'PLAN',   { size: 11, fill: C_GREY, bold: true })
    + txt(COL.amt.x,   startY + COL_H / 2 + 4, 'AMOUNT', { size: 11, fill: C_GREY, bold: true })
    + txt(COL.phone.x, startY + COL_H / 2 + 4, 'PHONE',  { size: 11, fill: C_GREY, bold: true });
}

// ── main export ──────────────────────────────────────────────────────────────

/**
 * Generate a PNG summary image for one gym.
 * Returns a Buffer ready for upload to Supabase Storage.
 */
export async function generateDailySummaryImage(
  gymName: string,
  dateLabel: string,
  expiringMembers: SummaryMember[],
  expiredMembers: SummaryMember[],
): Promise<Buffer> {
  let y   = 0;
  let svg = '';

  // ── header ────────────────────────────────────────────────────────────────
  y += 36;
  svg += txt(W / 2, y, 'Retainr', { size: 30, fill: C_ORANGE, anchor: 'middle', bold: true });
  y += 34;
  svg += txt(W / 2, y, x(gymName), { size: 20, fill: C_WHITE, anchor: 'middle', bold: true });
  y += 26;
  svg += txt(W / 2, y, x(dateLabel), { size: 13, fill: C_GREY, anchor: 'middle' });
  y += 20;
  svg += rect(PAD, y, W - PAD * 2, 1, C_BORDER);  // horizontal rule
  y += 24;

  // ── section 1: expiring today ─────────────────────────────────────────────
  svg += rect(0, y, W, SEC_H, C_ORANGE);
  // Warning triangle (▲) drawn as SVG polygon
  const t1y = y + SEC_H / 2;
  svg += `<polygon points="${PAD},${t1y + 9} ${PAD + 10},${t1y - 9} ${PAD + 20},${t1y + 9}" fill="${C_WHITE}" opacity="0.9"/>`;
  svg += txt(PAD + 28, y + SEC_H / 2 + 7, `Expiring Today (${expiringMembers.length})`,
    { size: 15, fill: C_WHITE, bold: true });
  y += SEC_H;

  svg += buildColHeaders(y, C_COL_EXP);
  y += COL_H;

  const s1 = expiringMembers.length > 0
    ? buildRows(expiringMembers, y)
    : buildEmpty(y, 'No members expiring today');
  svg += s1.svg;
  y += s1.h;

  y += 20; // gap between sections

  // ── section 2: already expired ────────────────────────────────────────────
  svg += rect(0, y, W, SEC_H, C_RED);
  // Filled circle as "alert" indicator
  const c2y = y + SEC_H / 2;
  svg += `<circle cx="${PAD + 10}" cy="${c2y}" r="10" fill="${C_WHITE}" opacity="0.9"/>`;
  svg += `<line x1="${PAD + 10}" y1="${c2y - 5}" x2="${PAD + 10}" y2="${c2y + 1}" stroke="${C_RED}" stroke-width="2.5" stroke-linecap="round"/>`;
  svg += `<circle cx="${PAD + 10}" cy="${c2y + 5}" r="1.5" fill="${C_RED}"/>`;
  svg += txt(PAD + 28, y + SEC_H / 2 + 7, `Already Expired (${expiredMembers.length})`,
    { size: 15, fill: C_WHITE, bold: true });
  y += SEC_H;

  svg += buildColHeaders(y, C_COL_DEAD);
  y += COL_H;

  const s2 = expiredMembers.length > 0
    ? buildRows(expiredMembers, y)
    : buildEmpty(y, 'No overdue members');
  svg += s2.svg;
  y += s2.h;

  // ── footer ────────────────────────────────────────────────────────────────
  y += 20;
  svg += rect(PAD, y, W - PAD * 2, 1, C_BORDER);
  y += 20;
  svg += txt(W / 2, y, 'retainr.in', { size: 12, fill: C_GREY, anchor: 'middle' });
  y += 28;

  const H = y;

  const fullSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${C_BG}"/>
  ${svg}
</svg>`;

  return sharp(Buffer.from(fullSvg)).png({ compressionLevel: 7 }).toBuffer();
}
