// Receipt PDF, generated in the browser from data the signed-in user is
// already allowed to see. jsPDF is loaded only when someone asks for a PDF.

import { t } from '../i18n';
import { checkCounts, formatDateTime, receiptNumber } from './format';
import { isDemo } from './supabase';
import type { Status } from './drafts';

export interface ReceiptData {
  id: string;
  shelterId: string;
  shelterAddress: string;
  kommun: string;
  ownerName: string;
  inspectorName: string;
  submittedAt: string;
  checklistTitle: string;
  isPlaceholder: boolean;
  counts: { ok: number; brist: number; na: number };
  items: { position: number; title: string; status: Status; comment: string; photoUrls: string[] }[];
}

const MARGIN = 18;
const PAGE_W = 210;
const PAGE_H = 297;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BOTTOM = PAGE_H - 20;

async function toDataUrl(url: string): Promise<{ data: string; width: number; height: number } | null> {
  try {
    const blob = await (await fetch(url)).blob();
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return { data, ...size };
  } catch {
    return null;
  }
}

export async function downloadReceiptPdf(r: ReceiptData): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  let y = MARGIN;

  const ensure = (height: number) => {
    if (y + height > BOTTOM) {
      doc.addPage();
      y = MARGIN;
    }
  };
  const text = (value: string, size: number, style: 'normal' | 'bold' = 'normal', gap = 1.5) => {
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
    const lines = doc.splitTextToSize(value, CONTENT_W) as string[];
    const lineH = size * 0.42;
    ensure(lines.length * lineH);
    doc.text(lines, MARGIN, y + lineH * 0.8);
    y += lines.length * lineH + gap;
  };

  doc.setTextColor(90);
  text('skyddsrum.se · Beredskap', 9);
  doc.setTextColor(0);
  text(t('receipt.pdfTitle'), 18, 'bold', 3);

  if (isDemo) {
    doc.setDrawColor(0);
    doc.setLineWidth(0.6);
    doc.rect(MARGIN, y, CONTENT_W, 9);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.text(t('receipt.pdfDemo'), PAGE_W / 2, y + 6, { align: 'center' });
    y += 13;
  }

  const rows: [string, string][] = [
    [t('receipt.number'), `${receiptNumber(r.id)}  (${r.id})`],
    [t('receipt.shelter'), `${r.shelterAddress}, ${r.kommun} (${r.shelterId})`],
    [t('receipt.owner'), r.ownerName],
    [t('receipt.inspector'), r.inspectorName],
    [t('receipt.submittedAt'), formatDateTime(r.submittedAt)],
    [t('receipt.checklist'), r.checklistTitle],
    [t('receipt.summary'), checkCounts(r.counts.ok, r.counts.brist, r.counts.na)],
  ];
  doc.setFontSize(10);
  for (const [label, value] of rows) {
    const lines = doc.splitTextToSize(value, CONTENT_W - 42) as string[];
    ensure(lines.length * 4.6);
    doc.setFont('helvetica', 'bold');
    doc.text(label, MARGIN, y + 3.5);
    doc.setFont('helvetica', 'normal');
    doc.text(lines, MARGIN + 42, y + 3.5);
    y += lines.length * 4.6 + 1;
  }
  y += 2;
  if (r.isPlaceholder) {
    doc.setTextColor(90);
    text(t('check.placeholder'), 9, 'normal', 3);
    doc.setTextColor(0);
  }

  for (const item of r.items) {
    ensure(18);
    doc.setDrawColor(200);
    doc.setLineWidth(0.2);
    doc.line(MARGIN, y, PAGE_W - MARGIN, y);
    y += 3;
    text(`${item.position}. ${item.title}`, 11, 'bold', 1);
    text(`${t('check.statusLabel')}: ${t(`check.status.${item.status}`).toUpperCase()}`, 10, 'bold', 1);
    text(item.comment || t('receipt.noComment'), 10, 'normal', 2);

    // Photos, three per row.
    const images = (await Promise.all(item.photoUrls.map(toDataUrl))).filter(Boolean) as Awaited<ReturnType<typeof toDataUrl>>[];
    const cellW = (CONTENT_W - 8) / 3;
    for (let i = 0; i < images.length; i += 3) {
      const row = images.slice(i, i + 3);
      const rowH = Math.max(...row.map((img) => (cellW * img!.height) / img!.width));
      const h = Math.min(rowH, 60);
      ensure(h + 3);
      row.forEach((img, j) => {
        const w = Math.min(cellW, (h * img!.width) / img!.height);
        const ih = (w * img!.height) / img!.width;
        doc.addImage(img!.data, 'JPEG', MARGIN + j * (cellW + 4), y, w, ih);
      });
      y += h + 3;
    }
    y += 2;
  }

  const pages = doc.getNumberOfPages();
  const generated = t('receipt.pdfGenerated', { date: formatDateTime(new Date().toISOString()) });
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(110);
    doc.text(generated, MARGIN, PAGE_H - 10);
    doc.text(t('receipt.pdfPage', { n: p, total: pages }), PAGE_W - MARGIN, PAGE_H - 10, { align: 'right' });
    if (isDemo) doc.text(t('receipt.pdfDemo'), PAGE_W / 2, PAGE_H - 10, { align: 'center' });
  }

  const date = r.submittedAt.slice(0, 10);
  doc.save(`egenkontroll-${r.shelterId}-${date}-${receiptNumber(r.id)}.pdf`);
}
