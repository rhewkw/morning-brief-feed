// gh-upload.mjs — 피드 산출물(mp3·feed.xml·episodes.json)을 GitHub Contents API로 업로드
//
// 왜 이 스크립트인가:
//   클라우드 Routine 샌드박스에서 api.github.com 쓰기는 프록시의 "builtin injection"
//   (자격증명 자동 주입)이 502로 실패하는 일이 잦다(2026-06-26·29 연속 실패).
//   프록시는 보통 Authorization 헤더가 "없을 때만" 주입하므로, 여기서는 GH_TOKEN으로
//   **명시적 인증**해 그 주입 단계를 건너뛴다. 추가로 파일별 재시도(backoff)를 둔다.
//
// 전제: GH_TOKEN = morning-brief-feed 에 Contents: Read and write 권한이 있는 PAT.
//
// 사용:
//   node scripts/gh-upload.mjs --pubdir <FEED_DIR> --date <YYYY-MM-DD> [--slot pm]
//        [--repo rhewkw/morning-brief-feed] [--message "브리핑 ..."]

import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const API = "https://api.github.com";

function parseArgs(argv) {
  const a = { pubdir: null, date: null, slot: "", repo: "rhewkw/morning-brief-feed", message: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--pubdir") a.pubdir = argv[++i];
    else if (k === "--date") a.date = argv[++i];
    else if (k === "--slot") a.slot = argv[++i];
    else if (k === "--repo") a.repo = argv[++i];
    else if (k === "--message") a.message = argv[++i];
  }
  return a;
}

async function ghFetch(method, path, body) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(API + path, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "morning-news-upload",
          ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (method === "GET" && res.status === 404) return null; // 파일 없음(신규)
      const text = await res.text().catch(() => "");
      if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : {};
    } catch (e) {
      lastErr = e;
      if (attempt < 4) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr;
}

async function getSha(repo, path) {
  const r = await ghFetch("GET", `/repos/${repo}/contents/${encodeURI(path)}`);
  return r && r.sha ? r.sha : undefined;
}

async function putFile(repo, path, buf, message) {
  const sha = await getSha(repo, path); // 갱신 시 필수
  const body = { message, content: buf.toString("base64"), branch: "main", ...(sha ? { sha } : {}) };
  await ghFetch("PUT", `/repos/${repo}/contents/${encodeURI(path)}`, body);
  console.log(`  ✅ ${path} ${sha ? "(갱신)" : "(신규)"} ${(buf.length / 1024).toFixed(0)}KB`);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!TOKEN) {
    console.error("GH_TOKEN(쓰기 권한 PAT)이 없습니다. 업로드 불가.");
    process.exit(1);
  }
  if (!a.pubdir || !a.date) {
    console.error("사용법: --pubdir <FEED_DIR> --date <YYYY-MM-DD> [--slot pm]");
    process.exit(1);
  }
  const pubdir = resolve(a.pubdir);
  const slot = a.slot ? `-${a.slot}` : "";
  const mp3Name = `${a.date}${slot}.mp3`;
  const message = a.message || `브리핑 ${a.date}${slot}`;

  console.log(`업로드 → ${a.repo} (${a.date}${slot})`);
  // 작은 파일(메타) 먼저, 큰 mp3 마지막 — mp3가 실패해도 메타 갱신 여부를 알 수 있게.
  await putFile(a.repo, "episodes.json", readFileSync(join(pubdir, "episodes.json")), message);
  await putFile(a.repo, "feed.xml", readFileSync(join(pubdir, "feed.xml")), message);
  await putFile(a.repo, `episodes/${mp3Name}`, readFileSync(join(pubdir, "episodes", mp3Name)), message);
  console.log("업로드 완료.");
}

main().catch((e) => {
  console.error("업로드 실패:", e?.message || e);
  process.exit(1);
});
