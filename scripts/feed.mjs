// feed.mjs — 개인 팟캐스트 RSS(feed.xml) 생성/갱신
//
// 사용법:
//   node scripts/feed.mjs --mp3 <에피소드.mp3> --title "제목" --desc "요약"
//                         --date YYYY-MM-DD [--slot am|pm] [--time HH:MM]
//                         [--pubdir <게시폴더>]
//
// 하루에 여러 번(예: 아침 06:50, 오후 16:00) 발행하려면 --slot 으로 구분한다.
//   - 아침: --date 2026-06-08 --time 06:50            → id = 2026-06-08
//   - 오후: --date 2026-06-08 --slot pm --time 16:00  → id = 2026-06-08-pm
//
// 동작:
//   1) MP3 를 <pubdir>/episodes/<id>.mp3 로 복사
//   2) <pubdir>/episodes.json 에 에피소드 메타 기록(최근 keepEpisodes 개 유지)
//   3) <pubdir>/feed.xml 을 RSS 2.0 + iTunes 태그로 재생성
//
// pubdir(공개 피드 리포 체크아웃): --pubdir 인자 > 환경변수 PODCAST_PUBDIR >
// 로컬 기본값 ../morning-feed. 클라우드 routine은 공개 리포 클론 경로를 --pubdir로 넘긴다.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function loadConfig() {
  return JSON.parse(readFileSync(resolve(ROOT, "config.json"), "utf-8"));
}

function parseArgs(argv) {
  const a = { mp3: null, title: null, desc: null, date: null, slot: null, time: null, pubdir: null, remove: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--mp3") a.mp3 = argv[++i];
    else if (k === "--title") a.title = argv[++i];
    else if (k === "--desc") a.desc = argv[++i];
    else if (k === "--date") a.date = argv[++i];
    else if (k === "--slot") a.slot = argv[++i];
    else if (k === "--time") a.time = argv[++i];
    else if (k === "--pubdir") a.pubdir = argv[++i];
    else if (k === "--remove") a.remove = argv[++i]; // 에피소드 id(예: 2026-06-13 / 2026-06-13-pm) 삭제
  }
  return a;
}

function xmlEscape(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// 날짜(YYYY-MM-DD) + 시간(HH:MM) → RFC822 (KST 기준).
function rfc822(dateStr, timeStr = "06:00") {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${days[dow]}, ${String(d).padStart(2, "0")} ${months[m - 1]} ${y} ${String(hh).padStart(2,"0")}:${String(mm||"00").padStart(2,"0")}:00 +0900`;
}

// 기존/신규 메타에서 고유 id 도출 (하위호환).
function epId(ep) {
  if (ep.id) return ep.id;
  return ep.slot ? `${ep.date}-${ep.slot}` : ep.date;
}

function buildFeed(cfg, episodes) {
  const p = cfg.podcast;
  const items = episodes
    .map((ep) => {
      const id = epId(ep);
      const url = `${p.episodeBaseUrl}/${ep.file}`;
      return `    <item>
      <title>${xmlEscape(ep.title)}</title>
      <description>${xmlEscape(ep.desc)}</description>
      <itunes:summary>${xmlEscape(ep.desc)}</itunes:summary>
      <pubDate>${rfc822(ep.date, ep.time)}</pubDate>
      <enclosure url="${xmlEscape(url)}" length="${ep.size}" type="audio/mpeg"/>
      <guid isPermaLink="false">${xmlEscape(id)}</guid>
      <itunes:duration>${ep.duration || ""}</itunes:duration>
      <itunes:explicit>false</itunes:explicit>
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${xmlEscape(p.title)}</title>
    <link>${xmlEscape(p.siteUrl)}</link>
    <language>${xmlEscape(p.language || "ko")}</language>
    <description>${xmlEscape(p.description)}</description>
    <itunes:author>${xmlEscape(p.author)}</itunes:author>
    <itunes:summary>${xmlEscape(p.description)}</itunes:summary>
    <itunes:owner>
      <itunes:name>${xmlEscape(p.author)}</itunes:name>
    </itunes:owner>
    <itunes:image href="${xmlEscape(p.imageUrl)}"/>
    <itunes:category text="News"/>
    <itunes:explicit>false</itunes:explicit>
${items}
  </channel>
</rss>
`;
}

// 48kbps CBR 기준 길이 추정 → "MM:SS"
function estimateDuration(bytes) {
  const sec = Math.round((bytes * 8) / 48000);
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

function main() {
  const cfg = loadConfig();
  const args = parseArgs(process.argv.slice(2));

  // --remove 모드: 지정 id 에피소드 삭제 후 feed.xml 재생성
  if (args.remove) {
    const pubdir = resolve(
      args.pubdir || process.env.PODCAST_PUBDIR || resolve(ROOT, "..", "morning-feed")
    );
    const metaPath = join(pubdir, "episodes.json");
    let episodes = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf-8")) : [];
    const before = episodes.length;
    const target = episodes.find((e) => epId(e) === args.remove);
    episodes = episodes.filter((e) => epId(e) !== args.remove);
    if (target) {
      const mp3 = join(pubdir, "episodes", target.file);
      try { if (existsSync(mp3)) rmSync(mp3); } catch {}
    }
    writeFileSync(metaPath, JSON.stringify(episodes, null, 2));
    writeFileSync(join(pubdir, "feed.xml"), buildFeed(cfg, episodes));
    console.log(`삭제: ${args.remove} (${before} → ${episodes.length}개)`);
    return;
  }

  if (!args.mp3) {
    console.error('--mp3 <에피소드.mp3> 가 필요합니다.');
    process.exit(1);
  }
  const date = args.date || deriveDateFromPath(args.mp3);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error("날짜를 알 수 없습니다. --date YYYY-MM-DD 를 지정하세요.");
    process.exit(1);
  }
  const slot = (args.slot || "").trim();
  const time = args.time || "06:00";
  const id = slot ? `${date}-${slot}` : date;

  const pubdir = resolve(
    args.pubdir || process.env.PODCAST_PUBDIR || resolve(ROOT, "..", "morning-feed")
  );
  const epDir = join(pubdir, "episodes");
  mkdirSync(epDir, { recursive: true });

  // 1) MP3 복사
  const fileName = `${id}.mp3`;
  const dest = join(epDir, fileName);
  copyFileSync(resolve(args.mp3), dest);
  const size = statSync(dest).size;

  // 2) episodes.json 갱신
  const metaPath = join(pubdir, "episodes.json");
  let episodes = [];
  if (existsSync(metaPath)) {
    try { episodes = JSON.parse(readFileSync(metaPath, "utf-8")); } catch {}
  }
  episodes = episodes.filter((e) => epId(e) !== id); // 같은 id 갱신
  episodes.unshift({
    id,
    date,
    slot: slot || undefined,
    time,
    file: fileName,
    title: args.title || `${date} 브리핑`,
    desc: args.desc || "맞춤형 브리핑",
    size,
    duration: estimateDuration(size),
  });
  // 날짜+시간 기준 최신순 정렬
  episodes.sort((a, b) => {
    const ka = `${a.date}T${a.time || "00:00"}`;
    const kb = `${b.date}T${b.time || "00:00"}`;
    return ka < kb ? 1 : ka > kb ? -1 : 0;
  });
  const keep = cfg.podcast.keepEpisodes || 60;
  episodes = episodes.slice(0, keep);
  writeFileSync(metaPath, JSON.stringify(episodes, null, 2));

  // 3) feed.xml 재생성
  const feedPath = join(pubdir, "feed.xml");
  writeFileSync(feedPath, buildFeed(cfg, episodes));

  console.log(`에피소드 추가: ${dest} (${(size / 1024 / 1024).toFixed(2)}MB) [id=${id}, ${time}]`);
  console.log(`피드 갱신: ${feedPath} (총 ${episodes.length}개 에피소드)`);
  console.log(`구독 URL: ${cfg.podcast.feedUrl}`);
}

function deriveDateFromPath(p) {
  const m = basename(p).match(/(\d{4}-\d{2}-\d{2})/) || dirname(p).match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
}

main();
