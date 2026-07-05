// gh-upload.mjs — 하루 산출물(mp3·feed.xml·episodes.json)을 GitHub에 "단일 커밋"으로 업로드
//
// 왜 단일 커밋인가:
//   Contents API로 파일마다 PUT하면 하루 3개 커밋이 몰려, GitHub Pages가 여러 빌드를
//   연달아 처리하다 마지막 빌드가 취소·실패(errored)하는 일이 잦았다(2026-07-03·06).
//   Git Data API(blob→tree→commit→ref)로 3개 파일을 한 커밋에 묶으면 Pages 빌드가
//   하루 1회만 돌아 안정적이다.
// 왜 GH_TOKEN 명시 인증인가:
//   클라우드 프록시의 무인증 "builtin injection"이 502로 실패하므로, GH_TOKEN으로
//   직접 인증해 그 단계를 건너뛴다. (GH_TOKEN = feed 리포 Contents: Read and write PAT)
//
// 사용:
//   node scripts/gh-upload.mjs --pubdir <FEED_DIR> --date <YYYY-MM-DD> [--slot pm]
//        [--repo rhewkw/morning-brief-feed] [--branch main] [--message "..."] [--dry-run]

import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const API = "https://api.github.com";

function parseArgs(argv) {
  const a = { pubdir: null, date: null, slot: "", repo: "rhewkw/morning-brief-feed", branch: "main", message: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--pubdir") a.pubdir = argv[++i];
    else if (k === "--date") a.date = argv[++i];
    else if (k === "--slot") a.slot = argv[++i];
    else if (k === "--repo") a.repo = argv[++i];
    else if (k === "--branch") a.branch = argv[++i];
    else if (k === "--message") a.message = argv[++i];
    else if (k === "--dry-run") a.dryRun = true;
  }
  return a;
}

async function gh(method, path, body) {
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
      const text = await res.text().catch(() => "");
      if (!res.ok) throw new Error(`HTTP ${res.status} ${method} ${path} — ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : {};
    } catch (e) {
      lastErr = e;
      if (attempt < 4) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!TOKEN) {
    console.error("GH_TOKEN(쓰기 권한 PAT)이 없습니다. 업로드 불가.");
    process.exit(1);
  }
  if (!a.pubdir || !a.date) {
    console.error("사용법: --pubdir <FEED_DIR> --date <YYYY-MM-DD> [--slot pm] [--dry-run]");
    process.exit(1);
  }
  const pubdir = resolve(a.pubdir);
  const slot = a.slot ? `-${a.slot}` : "";
  const mp3Name = `${a.date}${slot}.mp3`;
  const message = a.message || `브리핑 ${a.date}${slot}`;

  // 업로드할 3개 파일 로드
  const files = [
    { path: `episodes/${mp3Name}`, buf: readFileSync(join(pubdir, "episodes", mp3Name)) },
    { path: "feed.xml", buf: readFileSync(join(pubdir, "feed.xml")) },
    { path: "episodes.json", buf: readFileSync(join(pubdir, "episodes.json")) },
  ];

  console.log(`단일 커밋 업로드 → ${a.repo}@${a.branch} (${a.date}${slot})${a.dryRun ? " [DRY-RUN]" : ""}`);

  // 1) 현재 브랜치의 최신 커밋·트리 sha
  const ref = await gh("GET", `/repos/${a.repo}/git/ref/heads/${a.branch}`);
  const baseCommitSha = ref.object.sha;
  const baseCommit = await gh("GET", `/repos/${a.repo}/git/commits/${baseCommitSha}`);
  const baseTreeSha = baseCommit.tree.sha;

  // 2) 파일별 blob 생성(mp3는 base64 바이너리)
  const tree = [];
  for (const f of files) {
    const blob = await gh("POST", `/repos/${a.repo}/git/blobs`, {
      content: f.buf.toString("base64"),
      encoding: "base64",
    });
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
    console.log(`  blob ${f.path} (${(f.buf.length / 1024).toFixed(0)}KB)`);
  }

  // 3) 기존 트리 위에 새 트리 생성(나머지 파일 보존)
  const newTree = await gh("POST", `/repos/${a.repo}/git/trees`, { base_tree: baseTreeSha, tree });

  // 4) 커밋 생성
  const commit = await gh("POST", `/repos/${a.repo}/git/commits`, {
    message,
    tree: newTree.sha,
    parents: [baseCommitSha],
  });

  // 5) 브랜치 ref 이동(= 커밋 반영). dry-run이면 생략.
  if (a.dryRun) {
    console.log(`✅ [DRY-RUN] 커밋 생성 검증 완료: ${commit.sha.slice(0, 7)} (ref 미변경, 브랜치 그대로)`);
    return;
  }
  await gh("PATCH", `/repos/${a.repo}/git/refs/heads/${a.branch}`, { sha: commit.sha });
  console.log(`✅ 단일 커밋 업로드 완료: ${commit.sha.slice(0, 7)} — ${files.length}개 파일 한 번에 반영`);
}

main().catch((e) => {
  console.error("업로드 실패:", e?.message || e);
  process.exit(1);
});
