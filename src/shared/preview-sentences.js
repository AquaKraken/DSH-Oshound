// src/shared/preview-sentences.js
// Short per-LOCALE preview sentences for the Settings → Piper voice "▶" button.
//
// Piper voices are LOCALE-SPECIFIC: a de_DE voice fed English text phonemizes it
// with German rules and sounds wrong. So the preview text must be in the voice's
// own locale. Each entry is one native sentence, taken VERBATIM from the user's
// "Piper TTS 58-locale speech test" script (4 piper_tts_58_locale_test_script.txt),
// keyed by the full locale code (e.g. "ar_JO", "de_DE", "en_GB", "hi_IN") — which is
// exactly what the catalogue stores as voice.locale.
//
// Lookup order in previewSentenceFor():
//   1. BY_LOCALE[locale]         — exact locale (full 58-locale coverage)
//   2. BY_LANGUAGE[languageCode] — ISO 639-1 (covers locales not in the 58, e.g. an
//                                  "en_AU" voice → the English line)
//   3. FALLBACK                  — English (never a blank)

const BY_LOCALE = {
  ar_JO: 'مرحبًا. هذا اختبار لتوليد الكلام باستخدام Piper. يرجى قراءة هذه الجملة بوضوح.',
  bg_BG: 'Здравейте. Това е тест на синтеза на реч с Piper. Моля, прочетете това изречение ясно.',
  bn_BD: 'নমস্কার। এটি Piper-এর স্পিচ সিন্থেসিস পরীক্ষার একটি বাক্য। অনুগ্রহ করে এই বাক্যটি পরিষ্কারভাবে পড়ুন।',
  ca_ES: 'Hola. Aquesta és una prova de síntesi de veu amb Piper. Si us plau, llegiu aquesta frase amb claredat.',
  cs_CZ: 'Dobrý den. Toto je test syntézy řeči pomocí Piperu. Přečtěte prosím tuto větu zřetelně.',
  cy_GB: 'Helo. Prawf synthese llais yw hwn gan ddefnyddio Piper. Darllenwch y frawddeg hon yn glir, os gwelwch yn dda.',
  da_DK: 'Hej. Dette er en test af talesyntese med Piper. Læs venligst denne sætning tydeligt.',
  de_DE: 'Hallo. Dies ist ein Test der Sprachsynthese mit Piper. Bitte lesen Sie diesen Satz deutlich vor.',
  el_GR: 'Γεια σας. Αυτή είναι μια δοκιμή σύνθεσης ομιλίας με το Piper. Παρακαλώ διαβάστε αυτή την πρόταση καθαρά.',
  en_GB: 'Hello. This is a Piper speech synthesis test. Please read this sentence clearly.',
  en_US: 'Hello. This is a Piper speech synthesis test. Please read this sentence clearly.',
  es_AR: 'Hola. Esta es una prueba de síntesis de voz con Piper. Por favor, leé esta frase claramente.',
  es_ES: 'Hola. Esta es una prueba de síntesis de voz con Piper. Por favor, lee esta frase claramente.',
  es_MX: 'Hola. Esta es una prueba de síntesis de voz con Piper. Por favor, lee esta frase claramente.',
  et_EE: 'Tere. See on Piperiga tehtav kõnesünteesi test. Palun lugege see lause selgelt ette.',
  eu_ES: 'Kaixo. Hau Piper erabiliz egindako ahots-sintesiaren proba da. Mesedez, irakurri esaldi hau argi.',
  fa_IR: 'سلام. این یک آزمایش سنتز گفتار با پایپر است. لطفاً این جمله را واضح بخوانید.',
  fi_FI: 'Hei. Tämä on Piperin puhesynteesin testi. Lukekaa tämä lause selkeästi.',
  fr_FR: 'Bonjour. Ceci est un test de synthèse vocale avec Piper. Veuillez lire cette phrase clairement.',
  he_IL: 'שלום. זהו מבחן לסינתזת דיבור באמצעות Piper. בבקשה קראו את המשפט הזה בבירור.',
  hi_IN: 'नमस्ते। यह Piper के वाक् संश्लेषण का परीक्षण है। कृपया इस वाक्य को स्पष्ट रूप से पढ़ें।',
  hu_HU: 'Üdvözlöm. Ez egy Piperrel végzett beszédszintézis-teszt. Kérem, olvassa fel ezt a mondatot érthetően.',
  hy_AM: 'Բարև։ Սա Piper-ի խոսքի սինթեզի փորձարկում է։ Խնդրում եմ, այս նախադասությունը կարդացեք հստակ։',
  id_ID: 'Halo. Ini adalah uji sintesis suara dengan Piper. Silakan baca kalimat ini dengan jelas.',
  is_IS: 'Halló. Þetta er prófun á talgervingu með Piper. Vinsamlegast lestu þessa setningu skýrt.',
  it_IT: 'Ciao. Questo è un test di sintesi vocale con Piper. Per favore, leggi questa frase chiaramente.',
  ja_JP: 'こんにちは。これはPiperを使った音声合成のテストです。この文をはっきり読んでください。',
  ka_GE: 'გამარჯობა. ეს არის Piper-ის მეტყველების სინთეზის ტესტი. გთხოვთ, ეს წინადადება მკაფიოდ წაიკითხოთ.',
  kk_KZ: 'Сәлеметсіз бе. Бұл Piper көмегімен сөйлеу синтезін тексеру. Осы сөйлемді анық оқыңыз.',
  ko_KR: '안녕하세요. 이것은 Piper 음성 합성 테스트입니다. 이 문장을 또렷하게 읽어 주세요.',
  ku_TR: 'Silav. Ev testek senteza dengê bi Piper e. Ji kerema xwe ev hevok bi zelalî bixwînin.',
  lb_LU: 'Moien. Dëst ass en Test vun der Sproochsynthese mat Piper. Liest w.e.g. dëse Saz kloer vir.',
  lt_LT: 'Sveiki. Tai yra kalbos sintezės su Piper testas. Prašau aiškiai perskaityti šį sakinį.',
  lv_LV: 'Sveiki! Šis ir runas sintēzes tests ar Piper. Lūdzu, skaidri izlasiet šo teikumu.',
  ml_IN: 'നമസ്കാരം. ഇത് Piper ഉപയോഗിച്ചുള്ള ശബ്ദസംശ്ലേഷണ പരീക്ഷണമാണ്. ദയവായി ഈ വാക്യം വ്യക്തമായി വായിക്കുക.',
  mr_IN: 'नमस्कार. ही Piper वापरून केलेली वाणी संश्लेषणाची चाचणी आहे. कृपया हे वाक्य स्पष्टपणे वाचा.',
  ne_NP: 'नमस्ते। यो Piper प्रयोग गरेर गरिएको वाक् संश्लेषणको परीक्षण हो। कृपया यो वाक्य स्पष्ट रूपमा पढ्नुहोस्।',
  nl_BE: 'Hallo. Dit is een test van spraaksynthese met Piper. Lees deze zin alstublieft duidelijk voor.',
  nl_NL: 'Hallo. Dit is een test van spraaksynthese met Piper. Lees deze zin alstublieft duidelijk voor.',
  no_NO: 'Hei. Dette er en test av talesyntese med Piper. Les denne setningen tydelig, takk.',
  pl_PL: 'Dzień dobry. To jest test syntezy mowy z użyciem Pipera. Proszę wyraźnie przeczytać to zdanie.',
  pt_BR: 'Olá. Este é um teste de síntese de voz com o Piper. Por favor, leia esta frase claramente.',
  pt_PT: 'Olá. Este é um teste de síntese de voz com o Piper. Por favor, leia esta frase de forma clara.',
  ro_RO: 'Bună ziua. Acesta este un test de sinteză vocală cu Piper. Vă rugăm să citiți clar această propoziție.',
  ru_RU: 'Здравствуйте. Это тест синтеза речи с помощью Piper. Пожалуйста, прочитайте это предложение чётко.',
  sk_SK: 'Dobrý deň. Toto je test syntézy reči pomocou Piperu. Prosím, prečítajte túto vetu zreteľne.',
  sl_SI: 'Pozdravljeni. To je preizkus sinteze govora s Piperjem. Prosimo, jasno preberite ta stavek.',
  sq_AL: 'Përshëndetje. Ky është një test i sintezës së të folurit me Piper. Ju lutemi, lexojeni këtë fjali qartë.',
  sr_RS: 'Здраво. Ово је тест синтезе говора помоћу Пајпера. Молим вас, прочитајте ову реченицу јасно.',
  sv_SE: 'Hej. Detta är ett test av talsyntes med Piper. Läs den här meningen tydligt.',
  sw_CD: 'Hujambo. Huu ni mtihani wa usanisi wa sauti kwa kutumia Piper. Tafadhali soma sentensi hii kwa uwazi.',
  te_IN: 'నమస్కారం. ఇది Piper ఉపయోగించి చేసే వాక్య సంశ్లేషణ పరీక్ష. దయచేసి ఈ వాక్యాన్ని స్పష్టంగా చదవండి.',
  th_TH: 'สวัสดี นี่คือการทดสอบการสังเคราะห์เสียงด้วย Piper โปรดอ่านข้อความนี้ให้ชัดเจน',
  tr_TR: 'Merhaba. Bu, Piper ile konuşma sentezi testidir. Lütfen bu cümleyi net bir şekilde okuyun.',
  uk_UA: 'Вітаю. Це тест синтезу мовлення за допомогою Piper. Будь ласка, прочитайте це речення чітко.',
  ur_PK: 'سلام۔ یہ Piper کے ذریعے تقریر کی ترکیب کا ٹیسٹ ہے۔ براہِ کرم اس جملے کو واضح طور پر پڑھیں۔',
  vi_VN: 'Xin chào. Đây là bài kiểm tra tổng hợp giọng nói bằng Piper. Vui lòng đọc rõ câu này.',
  zh_CN: '你好。这是使用 Piper 进行语音合成的测试。请清晰地读出这句话。',
};

// Fallback keyed by ISO 639-1: the first locale (in the script's order) for each
// language. So a voice whose locale isn't one of the 58 (e.g. "en_AU") still gets
// the right language line via its languageCode.
const BY_LANGUAGE = {};
for (const [locale, sentence] of Object.entries(BY_LOCALE)) {
  const code = locale.split(/[_-]/)[0].toLowerCase();
  if (!BY_LANGUAGE[code]) BY_LANGUAGE[code] = sentence;
}
// A multilingual "kokoro" Piper voice family has no single region — English is the
// safe, neutral default for it.
BY_LANGUAGE.kokoro = 'Hello. This is a Piper speech synthesis test. Please read this sentence clearly.';

const FALLBACK = 'Hello. This is a Piper speech synthesis test. Please read this sentence clearly.';

// Normalise to the catalogue convention: lowercase language + uppercase region
// ("de_DE"). Accepts either '_' or '-' between the parts; a bare 2-letter code
// passes through lower-cased. Returns null for empty input.
function normalizeLocale(v) {
  const s = String(v ?? '')
    .trim()
    .replace(/-/g, '_');
  if (!s) return null;
  const parts = s.split('_');
  if (parts.length === 2) return parts[0].toLowerCase() + '_' + parts[1].toUpperCase();
  if (parts.length === 1) return parts[0].toLowerCase();
  return s;
}

// The catalogue always sets voice.locale, but defensively recover the locale from
// the voice key ("en_US-hfc_female-medium" -> "en_US") if it is ever missing.
function localeFromKey(key) {
  const head = String(key ?? '')
    .trim()
    .split('-')[0];
  return head ? normalizeLocale(head) : null;
}

/**
 * Returns a short preview sentence in the voice's own locale (full 58-locale
 * coverage, with an ISO 639-1 and an English fallback). Never returns a blank.
 * @param {{locale?: string, languageCode?: string, key?: string}} voice
 * @returns {string}
 */
export function previewSentenceFor(voice) {
  if (!voice) return FALLBACK;
  // 1) Exact locale code (the full 58-locale table).
  const locale = normalizeLocale(voice.locale) ?? localeFromKey(voice.key);
  if (locale && BY_LOCALE[locale]) return BY_LOCALE[locale];
  // 2) ISO 639-1 language code (covers locales not in the 58).
  const code = String(voice.languageCode ?? (locale ? locale.split(/[_-]/)[0] : ''))
    .toLowerCase()
    .trim();
  if (code && BY_LANGUAGE[code]) return BY_LANGUAGE[code];
  // 3) Region-qualified code: take the leading language part before giving up.
  const head = code.split(/[-_]/)[0];
  return (head && BY_LANGUAGE[head]) || FALLBACK;
}
