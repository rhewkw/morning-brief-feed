// tts.mjs — 대본 텍스트 → 한국어 뉴럴 음성 MP3
//
// 백엔드 자동 분기(우선순위): GOOGLE_TTS_API_KEY → OPENAI_API_KEY → AZURE_SPEECH_KEY
//   → node-edge-tts(로컬 무료). 클라우드 Routine은 Google Cloud TTS(Chirp 3 HD) 사용.
//   ⚠️ Google은 요청당 input 5,000바이트 한도 → 청크는 글자가 아닌 UTF-8 바이트로 자른다.
//
// 사용법:
//   node scripts/tts.mjs --in <대본.txt> --out <출력.mp3>
//   node scripts/tts.mjs "낭독할 문장"            // → output/test.mp3
//
// 긴 대본은 문단 단위로 분할 합성한 뒤 MP3 버퍼를 이어붙여 한 파일로 만든다.
// (MPEG 오디오 프레임은 단순 concat 으로 재생 가능 — ffmpeg 불필요)

// node-edge-tts 는 로컬 무료 백엔드 전용 → 지연(동적) import 로 두어,
// 클라우드(Google TTS)에서는 npm 설치 없이도 동작하게 한다.
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const GOOGLE_KEY = process.env.GOOGLE_TTS_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const AZURE_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_REGION = process.env.AZURE_SPEECH_REGION || "koreacentral";
// TTS_BACKEND=gtranslate 로 무료 백엔드를 강제 지정할 수 있다.
const BACKEND_OVERRIDE = (process.env.TTS_BACKEND || "").trim().toLowerCase();

// "+10%" / "0.9" 등을 OpenAI speed(0.25~4.0)로 변환
function parseRateToSpeed(rate) {
  if (!rate || rate === "default") return 1.0;
  const m = String(rate).match(/([+-]?\d+(?:\.\d+)?)\s*%/);
  if (m) return Math.min(4, Math.max(0.25, 1 + Number(m[1]) / 100));
  const n = Number(rate);
  return Number.isFinite(n) && n > 0 ? Math.min(4, Math.max(0.25, n)) : 1.0;
}

function loadConfig() {
  const cfg = JSON.parse(readFileSync(resolve(ROOT, "config.json"), "utf-8"));
  return cfg.audio || {};
}

function parseArgs(argv) {
  const args = { in: null, out: null, text: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--in") args.in = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (!a.startsWith("--") && args.text === null) args.text = a;
  }
  return args;
}

// ---- 대본 청크 분할 (UTF-8 바이트 기준) ----------------------------------
// ⚠️ Google TTS text:synthesize 는 요청당 input 5,000바이트 한도.
//    한국어는 글자당 3바이트라 글자 수로 자르면 한도를 넘어 합성 실패/누락된다.
//    따라서 반드시 바이트 길이로 잘라 모든 청크가 한도 미만이 되도록 한다.
const MAX_BYTES = 4500; // 5,000B 한도에 안전 마진

const bytes = (s) => Buffer.byteLength(s, "utf8");

function splitSentences(text) {
  const parts = text.split(
    /(?<=[.!?。…])\s+|(?<=[다요죠음함])\s+(?=[A-Za-z가-힣])/
  );
  return parts.map((s) => s.trim()).filter(Boolean);
}

// 한 문장 자체가 한도를 넘으면 글자 단위로 바이트 한도까지 강제 분할
function hardSplitByBytes(s) {
  const out = [];
  let cur = "";
  for (const ch of s) {
    if (bytes(cur + ch) > MAX_BYTES) {
      if (cur) out.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function chunkScript(raw) {
  const paragraphs = raw
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n+/g, " ").trim())
    .filter(Boolean);

  // 1) 한도 이하의 조각들로 분해(문단 → 필요 시 문장 → 필요 시 바이트 강제분할)
  const pieces = [];
  for (const para of paragraphs) {
    if (bytes(para) <= MAX_BYTES) {
      pieces.push(para);
      continue;
    }
    for (const sent of splitSentences(para)) {
      if (bytes(sent) <= MAX_BYTES) pieces.push(sent);
      else pieces.push(...hardSplitByBytes(sent));
    }
  }

  // 2) 인접 조각을 한도 이하로 합쳐 청크 수 최소화
  const chunks = [];
  let buf = "";
  for (const p of pieces) {
    if (!buf) buf = p;
    else if (bytes(buf + " " + p) > MAX_BYTES) {
      chunks.push(buf);
      buf = p;
    } else buf += " " + p;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function xmlEscape(s = "") {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ---- Azure Speech REST 백엔드 -------------------------------------------
async function synthAzure(text, audio, attempt = 1) {
  const voice = audio.voice || "ko-KR-SunHiNeural";
  const fmt = audio.format || "audio-24khz-48kbitrate-mono-mp3";
  const rate = audio.rate && audio.rate !== "+0%" ? audio.rate : "0%";
  const pitch = audio.pitch && audio.pitch !== "+0Hz" ? audio.pitch : "0%";
  const ssml =
    `<speak version='1.0' xml:lang='ko-KR'>` +
    `<voice xml:lang='ko-KR' name='${voice}'>` +
    `<prosody rate='${rate}' pitch='${pitch}'>${xmlEscape(text)}</prosody>` +
    `</voice></speak>`;
  const url = `https://${AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": AZURE_KEY,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": fmt,
        "User-Agent": "morning-news",
      },
      body: ssml,
    });
    if (!res.ok) throw new Error(`Azure HTTP ${res.status} ${await res.text().catch(() => "")}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error("빈 오디오");
    return buf;
  } catch (e) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 800 * attempt));
      return synthAzure(text, audio, attempt + 1);
    }
    throw e;
  }
}

// ---- Google Cloud TTS 백엔드 (Chirp 3 HD, 음질 최우선) -------------------
async function synthGoogle(text, audio) {
  const speakingRate = parseRateToSpeed(audio.rate); // +10% → 1.1
  const primary = audio.googleVoice || "ko-KR-Chirp3-HD-Leda";
  const fallback = "ko-KR-Neural2-A"; // Chirp 음성 오류 시 대체(여성)
  const voices = primary === fallback ? [primary] : [primary, fallback];
  let lastErr;
  for (const name of voices) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(
          `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              input: { text },
              voice: { languageCode: "ko-KR", name },
              audioConfig: { audioEncoding: "MP3", speakingRate },
            }),
          }
        );
        if (!res.ok) throw new Error(`Google HTTP ${res.status} ${await res.text().catch(() => "")}`);
        const data = await res.json();
        if (!data.audioContent) throw new Error("빈 오디오");
        return Buffer.from(data.audioContent, "base64");
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 600 * attempt));
      }
    }
  }
  throw lastErr;
}

// ---- Google 번역 TTS 백엔드 (무료·API 키 불필요) -------------------------
// 키·결제·도메인 허용 설정이 전혀 필요 없다(translate.googleapis.com 은 기본 허용).
// ⚠️ 요청당 약 200자 한도 → GTRANS_MAX_CHARS 기준으로 잘게 나눠 순차 합성한다.
const GTRANS_MAX_CHARS = 180;

async function synthGoogleTranslate(text, attempt = 1) {
  const url =
    `https://translate.googleapis.com/translate_tts?ie=UTF-8&client=tw-ob&tl=ko` +
    `&q=${encodeURIComponent(text)}&textlen=${text.length}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`translate_tts HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) throw new Error("빈 오디오");
    return buf;
  } catch (e) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 700 * attempt));
      return synthGoogleTranslate(text, attempt + 1);
    }
    throw e;
  }
}

// 번역 TTS 음성은 낭독 속도가 느려(대본 5,500자에 약 16분) 그대로 쓰면 목표 8분을
// 크게 넘는다. ffmpeg atempo 로 음정을 유지한 채 속도만 올린다. ffmpeg 이 없으면
// 배속을 건너뛰고 원본을 그대로 내보낸다(오디오가 없는 것보다는 낫다).
function findFfmpeg() {
  const candidates = [
    process.env.FFMPEG_PATH,
    ...(() => {
      try {
        return [execFileSync("which", ["ffmpeg"], { encoding: "utf-8" }).trim()];
      } catch {
        return [];
      }
    })(),
    ...(() => {
      try {
        const root = execFileSync("npm", ["root", "-g"], { encoding: "utf-8" }).trim();
        return [join(root, "ffmpeg-static", "ffmpeg")];
      } catch {
        return [];
      }
    })(),
    resolve(ROOT, "node_modules", "ffmpeg-static", "ffmpeg"),
  ];
  return candidates.find((p) => p && existsSync(p)) || null;
}

function speedUp(buf, tempo) {
  if (!(tempo > 1)) return buf;
  const ff = findFfmpeg();
  if (!ff) {
    console.warn(`⚠️ ffmpeg 을 찾지 못해 ${tempo}배속을 건너뜁니다(원본 속도로 저장).`);
    console.warn(`   설치: npm install -g ffmpeg-static`);
    return buf;
  }
  const tmpIn = join(tmpdir(), `mn-tempo-in-${process.pid}.mp3`);
  const tmpOut = join(tmpdir(), `mn-tempo-out-${process.pid}.mp3`);
  try {
    writeFileSync(tmpIn, buf);
    // atempo 는 한 번에 0.5~2.0 배만 지원 → 범위를 넘으면 여러 단계로 나눈다.
    const stages = [];
    let left = tempo;
    while (left > 2) {
      stages.push(2);
      left /= 2;
    }
    stages.push(left);
    const filter = stages.map((s) => `atempo=${s.toFixed(4)}`).join(",");
    execFileSync(
      ff,
      ["-y", "-loglevel", "error", "-i", tmpIn, "-filter:a", filter,
       "-b:a", "64k", "-ar", "24000", "-ac", "1", tmpOut],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    return readFileSync(tmpOut);
  } finally {
    for (const p of [tmpIn, tmpOut]) {
      try { if (existsSync(p)) rmSync(p); } catch {}
    }
  }
}

// 글자 수 기준 분할: 문단 → 문장 → 쉼표/공백 순으로 끊어 문장 중간이 잘리지 않게 한다.
function chunkByChars(raw, maxChars) {
  const paragraphs = raw
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n+/g, " ").trim())
    .filter(Boolean);

  const pieces = [];
  for (const para of paragraphs) {
    for (const sent of splitSentences(para)) {
      if (sent.length <= maxChars) {
        pieces.push(sent);
        continue;
      }
      let buf = "";
      for (const part of sent.split(/(?<=[,·])\s*/)) {
        for (const word of part.length <= maxChars ? [part] : part.split(/\s+/)) {
          if (!buf) buf = word;
          else if ((buf + " " + word).length > maxChars) {
            pieces.push(buf);
            buf = word;
          } else buf += " " + word;
        }
      }
      if (buf) pieces.push(buf);
    }
  }

  // 인접 조각을 한도 이하로 다시 합쳐 요청 수를 줄인다.
  const chunks = [];
  let buf = "";
  for (const p of pieces) {
    if (!buf) buf = p;
    else if ((buf + " " + p).length > maxChars) {
      chunks.push(buf);
      buf = p;
    } else buf += " " + p;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

// ---- OpenAI TTS 백엔드 ---------------------------------------------------
async function synthOpenAI(text, audio, attempt = 1) {
  const model = audio.openaiModel || "tts-1";
  const voice = audio.openaiVoice || "nova";
  const speed = parseRateToSpeed(audio.rate);
  try {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, voice, input: text, response_format: "mp3", speed }),
    });
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status} ${await res.text().catch(() => "")}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error("빈 오디오");
    return buf;
  } catch (e) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 800 * attempt));
      return synthOpenAI(text, audio, attempt + 1);
    }
    throw e;
  }
}

// ---- node-edge-tts 백엔드 (로컬 무료) -----------------------------------
async function synthEdge(tts, text, tmpPath, attempt = 1) {
  try {
    await tts.ttsPromise(text, tmpPath);
    const buf = readFileSync(tmpPath);
    if (!buf.length) throw new Error("빈 오디오");
    return buf;
  } catch (e) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 800 * attempt));
      return synthEdge(tts, text, tmpPath, attempt + 1);
    }
    throw e;
  } finally {
    if (existsSync(tmpPath)) {
      try { rmSync(tmpPath); } catch {}
    }
  }
}

// ---- 메인 ----------------------------------------------------------------
async function main() {
  const audio = loadConfig();
  const args = parseArgs(process.argv.slice(2));

  let raw, outPath;
  if (args.in) {
    raw = readFileSync(resolve(args.in), "utf-8");
    outPath = resolve(args.out || args.in.replace(/\.txt$/i, ".mp3"));
  } else if (args.text) {
    raw = args.text;
    outPath = resolve(args.out || resolve(ROOT, "output", "test.mp3"));
  } else {
    console.error('입력이 없습니다. --in <파일> 또는 "문장" 을 지정하세요.');
    process.exit(1);
  }

  const pick =
    BACKEND_OVERRIDE ||
    (GOOGLE_KEY ? "google" : OPENAI_KEY ? "openai" : AZURE_KEY ? "azure" : "gtranslate");

  // 백엔드별 라벨·청크 방식. gtranslate 만 글자 수(약 200자) 한도라 따로 나눈다.
  const plans = {
    google: { label: "Google Cloud TTS", voice: audio.googleVoice || "ko-KR-Chirp3-HD-Leda" },
    openai: { label: "OpenAI", voice: audio.openaiVoice || "nova" },
    azure: { label: "Azure Speech", voice: audio.voice || "ko-KR-SunHiNeural" },
    edge: { label: "node-edge-tts(무료)", voice: audio.voice || "ko-KR-SunHiNeural" },
    gtranslate: { label: "Google 번역 TTS(무료·무키)", voice: "ko (translate)" },
  };

  async function synthesizeAll(name) {
    const plan = plans[name];
    if (!plan) throw new Error(`알 수 없는 백엔드: ${name}`);
    const chunks =
      name === "gtranslate" ? chunkByChars(raw, GTRANS_MAX_CHARS) : chunkScript(raw);
    console.log(
      `백엔드: ${plan.label} | 음성: ${plan.voice} | 청크 ${chunks.length}개 | 총 ${raw.length}자`
    );

    // edge 백엔드는 인스턴스 1개 재사용 (로컬 무료 전용 → 필요할 때만 동적 import)
    let edge = null;
    if (name === "edge") {
      const { EdgeTTS } = await import("node-edge-tts");
      edge = new EdgeTTS({
        voice: audio.voice || "ko-KR-SunHiNeural",
        lang: "ko-KR",
        outputFormat: audio.format || "audio-24khz-48kbitrate-mono-mp3",
        rate: audio.rate || "default",
        pitch: audio.pitch || "default",
        volume: audio.volume || "default",
        timeout: 60000,
      });
    }

    const stamp = process.pid + "-" + chunks.length;
    const buffers = [];
    for (let i = 0; i < chunks.length; i++) {
      process.stdout.write(`  합성 ${i + 1}/${chunks.length} ...`);
      let buf;
      if (name === "google") buf = await synthGoogle(chunks[i], audio);
      else if (name === "openai") buf = await synthOpenAI(chunks[i], audio);
      else if (name === "azure") buf = await synthAzure(chunks[i], audio);
      else if (name === "gtranslate") buf = await synthGoogleTranslate(chunks[i]);
      else buf = await synthEdge(edge, chunks[i], join(tmpdir(), `mn-tts-${stamp}-${i}.mp3`));
      buffers.push(buf);
      console.log(` ${(buf.length / 1024).toFixed(0)}KB`);
    }
    return Buffer.concat(buffers);
  }

  // 유료 백엔드가 결제·차단 등으로 실패하면 무료 백엔드로 자동 전환한다.
  // (브리핑이 오디오 없이 나가는 것보다 음질을 양보하는 편이 낫다)
  let final, used = pick;
  try {
    final = await synthesizeAll(pick);
  } catch (e) {
    if (pick === "gtranslate") throw e;
    console.warn(`\n⚠️ ${plans[pick].label} 실패: ${e?.message || e}`);
    console.warn(`   → 무료 백엔드(Google 번역 TTS)로 자동 전환합니다.\n`);
    used = "gtranslate";
    final = await synthesizeAll(used);
  }

  // 번역 TTS 로 만든 오디오만 배속 보정한다(유료 백엔드는 rate 설정으로 이미 조절됨).
  if (used === "gtranslate") {
    const tempo = Number(process.env.TTS_TEMPO || audio.gtranslateTempo || 1.8);
    if (tempo > 1) {
      const before = final.length;
      final = speedUp(final, tempo);
      if (final.length !== before) console.log(`\n${tempo}배속 적용 완료`);
    }
  }

  if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, final);

  // translate_tts 출력은 64kbps, 나머지 백엔드는 48kbps 기준
  const approxSec = Math.round((final.length * 8) / (used === "gtranslate" ? 64000 : 48000));
  console.log(
    `\n완료: ${outPath}\n크기 ${(final.length / 1024 / 1024).toFixed(2)}MB · 약 ${Math.floor(
      approxSec / 60
    )}분 ${approxSec % 60}초`
  );

  // 길이 검증: 대본 분량 대비 오디오가 비정상적으로 짧으면 누락 의심 → 경고
  const expectedSec = Math.round(raw.length / 13); // 한국어 낭독 대략 분당 ~780자
  if (approxSec < expectedSec * 0.6) {
    console.warn(
      `⚠️ 경고: 오디오가 예상보다 짧습니다(실제 약 ${approxSec}초 vs 예상 약 ${expectedSec}초). ` +
        `일부 청크가 누락됐을 수 있으니 반드시 확인하세요.`
    );
  }
}

main().catch((e) => {
  console.error("TTS 실패:", e?.message || e);
  process.exit(1);
});
