# NAPR Lookup

პირადი Chrome ექსთენშენი (Manifest V3) საკადასტრო კოდებთან სამუშაოდ: maps.gov.ge და ms.gov.ge რუკები, KML, რეესტრის ამონაწერები და საკადასტრო გეგმები, ნაკვეთის კონტურები (geojson.io), თბილისის აუქციონის ლოტები, ერთი და იგივე ადგილი სხვადასხვა რუკაზე.

## დაყენება

`tools/install.bat` ჩამოტვირთავს ბოლო Release-ის `napr_lookup.zip`-ს, ხსნის მას და Chrome-ში „Load unpacked“-ით დასაყენებლად ამზადებს. ექსთენშენი თავად ამოწმებს ახალ ვერსიას.

## საქაღალდეები

| | |
|---|---|
| `src/` | ექსთენშენის კოდი (ეს საქაღალდე თავად არის ექსთენშენი: Chrome-ში „Load unpacked“ → `src`) |
| `docs/KONTEKSTI.md` | პროექტის აღწერა: ფაილები, მონაცემთა წყაროები, შორთქათების სქემა, ღია საკითხები |
| `docs/napr_amonaweri_instruqcia.md` | რეესტრის ამონაწერისა და საკადასტრო გეგმის პოვნის ტექნიკური ინსტრუქცია |
| `tests/` | ავტომატური ტესტი (Playwright + Chromium, საიტების პასუხების იმიტაციით) და სატესტო გეგმების გენერატორი |
| `tools/build_zip.py` | ZIP-ის აწყობა: `python tools/build_zip.py` (DEMO) ან `--release` |
| `tools/install.bat` | Windows-ის დამყენებელი |
| `napr_lookup.zip` | ძველი ატვირთვა (3.x); ახალი ვერსიები Release-ებშია |

## ვერსიის გამოშვება

1. DEMO (`python tools/build_zip.py`) გატესტილია.
2. `src/manifest.json`-ში ვერსია ახალია.
3. `python tools/build_zip.py --release` → `dist/napr_lookup.zip`.
4. GitHub → Releases → ახალი Release, ფაილი ზუსტად `napr_lookup.zip` სახელით.

## ტესტი

```
python3 tests/make_test_plans.py tests/fixtures        # reportlab; qpdf - დაშიფრული ვარიანტისთვის
qpdf --allow-weak-crypto --encrypt "" own 128 --use-aes=n -- tests/fixtures/plan_hole.pdf tests/fixtures/plan_hole_rc4.pdf
node tests/test_extension.js src tests/fixtures tests/out [cadastre_pdf_to_kml.html]
node tests/test_plan_test.js src <ფიქსტურები: კოდი.pdf, კოდი.wkt, codes.txt> tests/out   # მასობრივი შემოწმების გვერდი
```

ბოლო (არასავალდებულო) არგუმენტი: `cadastre_pdf_to_kml.html` (რეპო `Eveghio/cadastre-pdf-to-kml`). მისი შედეგი უნდა ემთხვეოდეს ექსთენშენის კონვერტერს წერტილ-წერტილ.
