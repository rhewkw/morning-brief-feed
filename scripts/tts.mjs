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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const GOOGLE_KEY = process.env.GOOGLE_TTS_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const AZURE_KEY = process.env.AZURE_SPEECH_KEY;
const AZURE_REGION = process.env.AZURE_SPEECH_REGION || "koreacentral";

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

  const backend = GOOGLE_KEY
    ? "Google Cloud TTS"
    : OPENAI_KEY
    ? "OpenAI"
    : AZURE_KEY
    ? "Azure Speech"
    : "node-edge-tts(무료)";
  const voiceLabel = GOOGLE_KEY
    ? audio.googleVoice || "ko-KR-Chirp3-HD-Leda"
    : OPENAI_KEY
    ? audio.openaiVoice || "nova"
    : audio.voice || "ko-KR-SunHiNeural";
  const chunks = chunkScript(raw);
  console.log(
    `백엔드: ${backend} | 음성: ${voiceLabel} | 청크 ${chunks.length}개 | 총 ${raw.length}자`
  );

  // edge 백엔드는 인스턴스 1개 재사용 (로컬 무료 전용 → 필요할 때만 동적 import)
  let edge = null;
  if (!AZURE_KEY && !OPENAI_KEY && !GOOGLE_KEY) {
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
    if (GOOGLE_KEY) {
      buf = await synthGoogle(chunks[i], audio);
    } else if (OPENAI_KEY) {
      buf = await synthOpenAI(chunks[i], audio);
    } else if (AZURE_KEY) {
      buf = await synthAzure(chunks[i], audio);
    } else {
      const tmpPath = join(tmpdir(), `mn-tts-${stamp}-${i}.mp3`);
      buf = await synthEdge(edge, chunks[i], tmpPath);
    }
    buffers.push(buf);
    console.log(` ${(buf.length / 1024).toFixed(0)}KB`);
  }

  const final = Buffer.concat(buffers);
  if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, final);

  const approxSec = Math.round((final.length * 8) / 48000);
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
