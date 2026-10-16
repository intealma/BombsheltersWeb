// PDF exports (self-check receipt, maintenance log), generated in the browser
// from data the signed-in user is already allowed to see. jsPDF is loaded
// only when someone asks for a PDF.

import type { jsPDF as JsPdf } from 'jspdf';
import { t } from '../i18n';
import { checkCounts, formatDate, formatDateTime, receiptNumber } from './format';
import { isDemo } from './supabase';
import type { Status } from './drafts';

const MARGIN = 18;
const PAGE_W = 210;
const PAGE_H = 297;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BOTTOM = PAGE_H - 20;
const LABEL_W = 42;

interface LoadedImage {
  data: string;
  width: number;
  height: number;
}

async function loadImage(url: string): Promise<LoadedImage | null> {
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

/** Minimal flowing layout on top of jsPDF: text, label/value rows, rules, photo rows. */
class PdfWriter {
  y = MARGIN;

  constructor(readonly doc: JsPdf) {}

  static async create(): Promise<PdfWriter> {
    const { jsPDF } = await import('jspdf');
    return new PdfWriter(new jsPDF({ unit: 'mm', format: 'a4' }));
  }

  ensure(height: number) {
    if (this.y + height > BOTTOM) {
      this.doc.addPage();
      this.y = MARGIN;
    }
  }

  text(value: string, size: number, style: 'normal' | 'bold' = 'normal', gap = 1.5, grey = false) {
    const { doc } = this;
    doc.setFont('helvetica', style);
    doc.setFontSize(size);
    doc.setTextColor(grey ? 90 : 0);
    const lines = doc.splitTextToSize(value, CONTENT_W) as string[];
    const lineH = size * 0.42;
    this.ensure(lines.length * lineH);
    doc.text(lines, MARGIN, this.y + lineH * 0.8);
    this.y += lines.length * lineH + gap;
    doc.setTextColor(0);
  }

  /** Brand line, title and (in the demo) a boxed DEMO notice. */
  header(title: string) {
    this.text('skyddsrum.se · Beredskap', 9, 'normal', 1.5, true);
    this.text(title, 18, 'bold', 3);
    if (isDemo) {
      const { doc } = this;
      doc.setDrawColor(0);
      doc.setLineWidth(0.6);
      doc.rect(MARGIN, this.y, CONTENT_W, 9);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text(t('receipt.pdfDemo'), PAGE_W / 2, this.y + 6, { align: 'center' });
      this.y += 13;
    }
  }

  rows(pairs: [string, string][]) {
    const { doc } = this;
    doc.setFontSize(10);
    for (const [label, value] of pairs) {
      const lines = doc.splitTextToSize(value, CONTENT_W - LABEL_W) as string[];
      this.ensure(lines.length * 4.6);
      doc.setFont('helvetica', 'bold');
      doc.text(label, MARGIN, this.y + 3.5);
      doc.setFont('helvetica', 'normal');
      doc.text(lines, MARGIN + LABEL_W, this.y + 3.5);
      this.y += lines.length * 4.6 + 1;
    }
    this.y += 2;
  }

  rule(minSpace = 18) {
    this.ensure(minSpace);
    this.doc.setDrawColor(200);
    this.doc.setLineWidth(0.2);
    this.doc.line(MARGIN, this.y, PAGE_W - MARGIN, this.y);
    this.y += 3;
  }

  /** Photos, three per row, keeping their proportions. */
  async photos(urls: string[]) {
    const images = (await Promise.all(urls.map(loadImage))).filter((i): i is LoadedImage => i !== null);
    const cellW = (CONTENT_W - 8) / 3;
    for (let i = 0; i < images.length; i += 3) {
      const row = images.slice(i, i + 3);
      const h = Math.min(Math.max(...row.map((img) => (cellW * img.height) / img.width)), 60);
      this.ensure(h + 3);
      row.forEach((img, j) => {
        const w = Math.min(cellW, (h * img.width) / img.height);
        this.doc.addImage(img.data, 'JPEG', MARGIN + j * (cellW + 4), this.y, w, (w * img.height) / img.width);
      });
      this.y += h + 3;
    }
  }

  /** Footer on every page (generated time, page numbers, DEMO), then download. */
  save(filename: string) {
    const { doc } = this;
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
    doc.save(filename);
  }
}

// ---------------------------------------------------------------------------
// Self-check receipt
// ---------------------------------------------------------------------------

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

export async function downloadReceiptPdf(r: ReceiptData): Promise<void> {
  const pdf = await PdfWriter.create();
  pdf.header(t('receipt.pdfTitle'));
  pdf.rows([
    [t('receipt.number'), `${receiptNumber(r.id)}  (${r.id})`],
    [t('receipt.shelter'), `${r.shelterAddress}, ${r.kommun} (${r.shelterId})`],
    [t('receipt.owner'), r.ownerName],
    [t('receipt.inspector'), r.inspectorName],
    [t('receipt.submittedAt'), formatDateTime(r.submittedAt)],
    [t('receipt.checklist'), r.checklistTitle],
    [t('receipt.summary'), checkCounts(r.counts.ok, r.counts.brist, r.counts.na)],
  ]);
  if (r.isPlaceholder) pdf.text(t('check.placeholder'), 9, 'normal', 3, true);

  for (const item of r.items) {
    pdf.rule();
    pdf.text(`${item.position}. ${item.title}`, 11, 'bold', 1);
    pdf.text(`${t('check.statusLabel')}: ${t(`check.status.${item.status}`).toUpperCase()}`, 10, 'bold', 1);
    pdf.text(item.comment || t('receipt.noComment'), 10, 'normal', 2);
    await pdf.photos(item.photoUrls);
    pdf.y += 2;
  }

  pdf.save(`egenkontroll-${r.shelterId}-${r.submittedAt.slice(0, 10)}-${receiptNumber(r.id)}.pdf`);
}

// ---------------------------------------------------------------------------
// Maintenance log
// ---------------------------------------------------------------------------

export interface MaintenancePdfData {
  shelterId: string;
  shelterAddress: string;
  kommun: string;
  ownerName: string;
  entries: {
    id: string;
    performedOn: string;
    createdAt: string;
    category: string; // already translated
    description: string;
    performedBy: string;
    registeredBy: string;
    voided: { reason: string; at: string } | null;
    photoUrls: string[];
  }[];
}

export async function downloadMaintenancePdf(m: MaintenancePdfData): Promise<void> {
  const pdf = await PdfWriter.create();
  const active = m.entries.filter((e) => !e.voided);
  pdf.header(t('maintenance.pdfTitle'));
  pdf.rows([
    [t('receipt.shelter'), `${m.shelterAddress}, ${m.kommun} (${m.shelterId})`],
    [t('receipt.owner'), m.ownerName],
    [t('maintenance.period'), active.length ? `${formatDate(active[0].performedOn)} - ${formatDate(active.at(-1)!.performedOn)}` : '-'],
    [t('maintenance.entries'), t('maintenance.entryCount', { count: active.length, voided: m.entries.length - active.length })],
  ]);
  pdf.text(t('maintenance.pdfNote'), 9, 'normal', 3, true);

  for (const e of m.entries) {
    pdf.rule();
    pdf.text(`${formatDate(e.performedOn)} · ${e.category}${e.voided ? ` · ${t('maintenance.voided').toUpperCase()}` : ''}`, 11, 'bold', 1);
    pdf.text(e.description, 10, 'normal', 1);
    pdf.text(
      `${t('maintenance.performedBy')}: ${e.performedBy} · ${t('maintenance.registered')}: ${formatDateTime(e.createdAt)}${e.registeredBy ? ` (${e.registeredBy})` : ''}`,
      8.5,
      'normal',
      1.5,
      true,
    );
    if (e.voided) {
      pdf.text(`${t('maintenance.voidedReason', { date: formatDateTime(e.voided.at) })}: ${e.voided.reason}`, 9, 'bold', 1.5);
    }
    await pdf.photos(e.photoUrls);
    pdf.y += 2;
  }

  pdf.save(`underhallslogg-${m.shelterId}-${new Date().toISOString().slice(0, 10)}.pdf`);
}
