# გამოყენება: python3 tests/make_test_plans.py tests/fixtures
# სატესტო "საკადასტრო გეგმები": ბადე UTM ციფრებით, წითელი საზღვარი, ტექსტი (ნამდვილი გეგმის აგებულებით)
import sys, json, os
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
pdfmetrics.registerFont(TTFont("DV", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"))
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
M_PER_PT = 0.5
E0, N0 = 481900.0, 4617300.0          # UTM at pdf point (100, 150)
def to_pdf(e, n): return (100 + (e - E0) / M_PER_PT, 150 + (n - N0) / M_PER_PT)
def area(r): return abs(sum(r[i][0]*r[(i+1)%len(r)][1]-r[(i+1)%len(r)][0]*r[i][1] for i in range(len(r)))/2)

def plan(path, code, ring, date, hole=None, as_image=False, latin=False, x_lines=range(0, 5)):
    c = canvas.Canvas(path, pagesize=(595, 842))
    c.setFont("DV", 11)
    if latin:
        c.setFont("Helvetica", 11)
        c.drawString(40, 810, "sajaro reestris erovnuli saagento"); c.drawString(40, 795, "sakadastro gegma")
        c.drawString(40, 780, "sakadastro kodi"); c.drawString(140, 780, code)
        c.drawString(40, 765, "miwis nakveTis farTobi"); c.drawString(190, 765, "%.0f kv.m" % (area(ring) - (area(hole) if hole else 0)))
    else:
        c.drawString(40, 810, "საჯარო რეესტრის ეროვნული სააგენტო"); c.drawString(40, 795, "საკადასტრო გეგმა")
        c.drawString(40, 780, "საკადასტრო კოდი: " + code)
        c.drawString(40, 765, "ფართობი: %.0f კვ.მ (WGS 84 / UTM zone 38N)" % (area(ring) - (area(hole) if hole else 0)))
        c.drawString(40, 750, "კოორდინატთა სისტემა: WGS 84 / UTM zone 38N")
        c.drawString(40, 735, "მომზადების თარიღი: " + date)
    c.setStrokeColorRGB(0, 0, 0); c.setLineWidth(0.3)
    c.rect(100, 150, 400, 500)
    c.setFont("Helvetica", 7)
    for i in x_lines:                                      # vertical grid lines + easting labels
        x = 100 + i * 100
        c.line(x, 150, x, 650)
        c.drawCentredString(x, 140, "%d" % (E0 + i * 100 * M_PER_PT))
    for j in range(0, 6):                                  # horizontal grid lines + northing labels (vertical text)
        y = 150 + j * 100
        c.line(100, y, 500, y)
        c.saveState(); c.translate(94, y); c.rotate(90); c.drawCentredString(0, 0, "%d" % (N0 + j * 100 * M_PER_PT)); c.restoreState()
    c.setStrokeColorRGB(1, 0, 0); c.setLineWidth(1.2)
    for r in [ring] + ([hole] if hole else []):
        p = c.beginPath(); pts = [to_pdf(*q) for q in r]
        p.moveTo(*pts[0])
        for q in pts[1:]: p.lineTo(*q)
        p.close(); c.drawPath(p, stroke=1, fill=0)
    c.save()

A = [(481950, 4617350), (482020, 4617360), (482040, 4617430), (481990, 4617470), (481940, 4617420)]
B = [(481930, 4617330), (482060, 4617330), (482060, 4617500), (481930, 4617500)]
Bh = [(481980, 4617380), (482010, 4617380), (482010, 4617420), (481980, 4617420)]
plan(out + "/plan_c_2026.pdf", "01.10.14.028.016", A, "22/07/2026")
plan(out + "/plan_c_2015.pdf", "01.10.14.028.016", B, "", latin=True)
plan(out + "/plan_one_line.pdf", "01.10.14.028.016", A, "", latin=True, x_lines=[2])
plan(out + "/plan_hole.pdf", "01.72.14.011.200", B, "03/02/2025", hole=Bh)
json.dump({"A": A, "B": B, "Bh": Bh, "areaA": area(A)}, open(out + "/truth.json", "w"))
