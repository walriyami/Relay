/** Searchable text on each page; padding forces real range requests without a new dependency. */
export function readingPdf(name: string, count = 3, padding = 0) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${count} >>`,
  ];
  for (let i = 0; i < count; i++) {
    const text = `%${" ".repeat(padding)}\nBT /F1 24 Tf 72 700 Td (Invoice page ${i + 1} END) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${3 + count * 2} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
      `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    );
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, i) => {
    const start = body.length;
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return start;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { name, mimeType: "application/pdf", buffer: Buffer.from(body) };
}

function document(name: string, objects: string[]) {
  let body = "%PDF-1.7\n";
  const offsets = objects.map((object, i) => {
    const offset = Buffer.byteLength(body);
    body += `${i + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { name, mimeType: "application/pdf", buffer: Buffer.from(body) };
}

const stream = (text: string) => `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;

export function mixedPdf() {
  const sizes = [
    [612, 792, 0],
    [612, 792, 90],
    [1500, 600, 0],
    [400, 1600, 0],
  ];
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R 9 0 R] /Count 4 >>"];
  sizes.forEach(([width, height, rotation], i) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Rotate ${rotation} /Resources << /Font << /F1 11 0 R >> >> /Contents ${4 + i * 2} 0 R >>`,
      stream(`BT /F1 24 Tf 72 ${height - 92} Td (Mixed page ${i + 1}) Tj ET`),
    );
  });
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  return document("reader-mixed.pdf", objects);
}
