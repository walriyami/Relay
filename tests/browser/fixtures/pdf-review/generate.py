"""Independent PR22 regression fixtures; generated once, not a browser-test dependency.

reportlab==4.4.9 Pillow==12.3.0 pypdf==6.10.0
REVIEW_FIXTURES selects output directory; REVIEW_FONT selects DejaVuSans.ttf.
"""
from pathlib import Path
from PIL import Image, ImageDraw, features
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from pypdf import PdfReader, PdfWriter
import io, os

root=Path(os.environ.get('REVIEW_FIXTURES','/tmp/pr22-repro-fixtures'))
root.mkdir(parents=True,exist_ok=True)
pdfmetrics.registerFont(TTFont('FixtureDejaVu',os.environ.get(
 'REVIEW_FONT','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')))

c=canvas.Canvas(str(root/'embedded-rotated.pdf'),pageCompression=1)
for n in range(1,4):
 c.setFont('FixtureDejaVu',20)
 c.drawString(60,700,f'Rotation fixture page {n}: café Ω Привет')
 c.setFont('FixtureDejaVu',13)
 c.drawString(60,660,'Left column alpha: selectable text')
 c.drawString(330,660,'Right column beta: visible text')
 c.showPage()
c.save()
r=PdfReader(root/'embedded-rotated.pdf');w=PdfWriter()
for i,p in enumerate(r.pages):
 if i==1:p.rotate(90)
 w.add_page(p)
w.write(root/'embedded-rotated.pdf')

pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
c=canvas.Canvas(str(root/'cjk-cmap.pdf'))
c.setFont('Helvetica',18);c.drawString(60,740,'Built-in CMap fixture')
c.setFont('STSong-Light',24);c.drawString(60,680,'中文测试：文档阅读与搜索')
c.save()

def pdf(objects,name):
 body=b'%PDF-1.7\n';offsets=[]
 for i,obj in enumerate(objects,1):
  offsets.append(len(body))
  body+=f'{i} 0 obj\n'.encode()+obj+b'\nendobj\n'
 xref=len(body)
 body+=f'xref\n0 {len(objects)+1}\n0000000000 65535 f \n'.encode()
 body+=b''.join(f'{o:010d} 00000 n \n'.encode() for o in offsets)
 body+=f'trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
 (root/name).write_bytes(body)

def stream(data):
 return b'<< /Length '+str(len(data)).encode()+b' >>\nstream\n'+data+b'\nendstream'

def imagepdf(data,props,name):
 pdf([
  b'<< /Type /Catalog /Pages 2 0 R >>',
  b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
  stream(b'q 520 0 0 375 40 250 cm /Im0 Do Q'),
  b'<< /Type /XObject /Subtype /Image /Width 900 /Height 650 '+props+
  b' /Length '+str(len(data)).encode()+b' >>\nstream\n'+data+b'\nendstream'
 ],name)

img=Image.new('RGB',(900,650),'white');d=ImageDraw.Draw(img)
d.rectangle((30,30,870,620),fill='#dfeefc',outline='navy',width=8)
d.ellipse((100,130,360,390),fill='red')
d.rectangle((470,150,780,460),fill='green')
d.text((90,60),'SCANNED FIXTURE - red circle and green rectangle',fill='black')

assert features.check('jpg_2000'),'Pillow requires JPEG2000/OpenJPEG support'
jpx=io.BytesIO();img.save(jpx,format='JPEG2000')
imagepdf(jpx.getvalue(),
 b'/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode',
 'jpx-image.pdf')

tiff=io.BytesIO()
img.convert('1').save(tiff,format='TIFF',compression='group4',strip_size=1_000_000)
tiff.seek(0)
with Image.open(tiff) as t:
 offsets=t.tag_v2[273];lengths=t.tag_v2[279]
assert len(offsets)==len(lengths)==1,'Expected one Group4 strip'
imagepdf(tiff.getvalue()[offsets[0]:offsets[0]+lengths[0]],
 b'/BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 900 /Rows 650 /BlackIs1 false >>',
 'ccitt-scan.pdf')

op=b'/H1 << /MCID 0 >> BDC BT /F1 24 Tf 60 720 Td (Tagged heading fixture) Tj ET EMC\n/P << /MCID 1 >> BDC BT /F1 16 Tf 60 670 Td (Accessible paragraph in reading order) Tj ET EMC'
pdf([
 b'<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 6 0 R /MarkInfo << /Marked true >> /Lang (en-US) >>',
 b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
 b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /StructParents 0 /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
 stream(op),
 b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
 b'<< /Type /StructTreeRoot /K [7 0 R 8 0 R] /ParentTree 9 0 R >>',
 b'<< /Type /StructElem /S /H1 /P 6 0 R /Pg 3 0 R /K 0 >>',
 b'<< /Type /StructElem /S /P /P 6 0 R /Pg 3 0 R /K 1 >>',
 b'<< /Nums [0 [7 0 R 8 0 R]] >>'
],'tagged.pdf')
print([(p.name,p.stat().st_size) for p in root.glob('*.pdf')])
