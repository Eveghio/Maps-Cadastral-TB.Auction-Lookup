// content_geojson.js - geojson.io-ზე ms.gov.ge-ს 2024 წლის ორთოფოტოს ფენა (DEMO2, საცდელი).
//
// geojson.io საკუთარ ფენებს (Custom raster layers) ინახავს localStorage-ში, გასაღებით "customRasterLayers",
// და კითხულობს გვერდის ჩატვირთვისას. ეს სკრიპტი გვერდის სკრიპტებზე ადრე სრულდება (document_start):
//   ბმულში ?napr_ortho=1  -> ჩვენი ფენა ემატება (თუ ჯერ არ არის)
//   სხვა შემთხვევაში       -> ჩვენი ფენა იშლება (ჩვეულებრივი "რუკაზე ჩვენება" ორთოს გარეშე რჩება)
// სხვა ფენებს (რაც მომხმარებელმა თავად დაამატა) არ ვეხებით.
//
// ms.gov.ge ფილებს მხოლოდ საკუთარ რუკას აძლევს; geojson.io-დან წამოსულ მოთხოვნებს ექსთენშენი
// "ms.gov.ge-დან მოსულად" აფორმებს (rules_ortho.json, declarativeNetRequest). ეს შეიძლება ნებისმიერ დროს
// შეწყდეს, თუ ms.gov.ge შემოწმებას შეცვლის.
(() => {
  const STORAGE_KEY = "customRasterLayers";
  const ORTHO_LAYER = {
    id: "napr-lookup-ms-ortho-2024",
    name: "ორთოფოტო 2024 (ms.gov.ge)",
    tileUrl: "https://ms.gov.ge/gis-api/v1/tileserver/image2024/{x}/{y}/{z}", // ms.gov.ge-ზე რიგი x/y/z-ა
    order: 0,
    visible: true
  };
  const wantOrtho = new URLSearchParams(location.search).get("napr_ortho") === "1";
  let layers = [];
  try { layers = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch (error) { layers = []; }
  if (!Array.isArray(layers)) layers = [];
  const otherLayers = layers.filter((layer) => layer && layer.id !== ORTHO_LAYER.id);
  const hadOrtho = otherLayers.length !== layers.length;
  if (wantOrtho) localStorage.setItem(STORAGE_KEY, JSON.stringify([ORTHO_LAYER, ...otherLayers]));
  else if (hadOrtho) localStorage.setItem(STORAGE_KEY, JSON.stringify(otherLayers));
})();
