/**
 * Netlify Serverless Function: daily-missa.js
 * 경로: netlify/functions/daily-missa.js
 * 설명: ?date=YYYY-MM-DD 쿼리를 받아 가톨릭 굿뉴스(maria.catholic.or.kr) 매일미사 원문을
 *       실시간으로 조회·파싱하여 전례력, 전례색, 추천 성가, 9개 전례문 본문을 JSON으로 반환합니다.
 */

// HTML 엔티티 디코딩 및 태그 제거 유틸리티
function cleanHtmlText(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

// 전례명 앞의 (녹), (백), (자), (홍) 기호로 전례색 판별
function detectLiturgicalColor(title) {
  const match = (title || '').match(/\(([녹백자홍흑장])\)/);
  if (!match) return 'green';
  const code = match[1];
  if (code === '백') return 'white';
  if (code === '자' || code === '흑') return 'purple';
  if (code === '홍' || code === '장') return 'red';
  return 'green';
}

// 굿뉴스 매일미사 HTML 본문에서 제목, 성가, 전례문 섹션 추출
function parseGoodnewsHtml(html, dateStr, sourceUrl) {
  // 1. 전례력 제목 추출 (예: (백) 온 누리의 임금이신 우리 주 예수 그리스도 왕 대축일(성서 주간))
  let rawTitle = '';
  const titlePatterns = [
    /<div[^>]*class=["'][^"']*tit[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    /<h[1-4][^>]*>([\s\S]*?\([녹백자홍흑장]\)[\s\S]*?)<\/h[1-4]>/i,
    /(\([녹백자홍흑장]\)\s*[^\r\n<]{2,80})/i
  ];
  for (const regex of titlePatterns) {
    const m = html.match(regex);
    if (m && m[1]) {
      const candidate = cleanHtmlText(m[1]).replace(/^\[|\]$/g, '').trim();
      if (candidate.length >= 3 && candidate.length <= 100) {
        rawTitle = candidate;
        break;
      }
    }
  }
  if (!rawTitle) {
    rawTitle = `(녹) ${dateStr} 매일미사`;
  }

  const color = detectLiturgicalColor(rawTitle);

  // 2. 추천 성가 추출 (입당 / 예물준비(봉헌) / 영성체 / 파견)
  const extractHymn = (labelRegex) => {
    const m = html.match(new RegExp(labelRegex + '[\\s\\S]{0,120}?(\\d{1,3})\\s*(?:번|장)?', 'i'));
    return m ? m[1] : '';
  };
  const hymns = {
    entrance: extractHymn('입당(?:성가)?'),
    offertory: extractHymn('(?:봉헌|예물\\s*준비)(?:성가)?'),
    communion: extractHymn('(?:영성체|성체)(?:성가)?'),
    recessional: extractHymn('파견(?:성가)?')
  };

  // 3. 섹션별 본문 및 성경 구절 추출 헬퍼
  const sectionMarkers = [
    { key: 'today_liturgy', labels: ['오늘 전례', '전례 안내'] },
    { key: 'reading1', labels: ['제1독서', '독서'] },
    { key: 'psalm', labels: ['화답송'] },
    { key: 'reading2', labels: ['제2독서'] },
    { key: 'acclamation', labels: ['복음환호송', '복음 환호송'] },
    { key: 'gospel', labels: ['복음'] },
    { key: 'prayers', labels: ['보편지향기도', '신자들의 기도'] },
    { key: 'communion', labels: ['영성체송'] },
    { key: 'meditation', labels: ['영성체 후 묵상', '영성체후 묵상'] }
  ];

  const plainBody = cleanHtmlText(html);
  const readings = {
    today_liturgy: '',
    reading1_ref: '',
    reading1: '',
    psalm_ref: '',
    psalm: '',
    reading2_ref: '',
    reading2: '',
    acclamation_ref: '',
    acclamation: '',
    gospel_ref: '',
    gospel: '',
    prayers: '',
    communion_ref: '',
    communion: '',
    meditation: ''
  };

  // 각 전례 항목의 시작 인덱스를 찾아 구간별로 본문 분리
  const foundPositions = [];
  for (const sec of sectionMarkers) {
    for (const lbl of sec.labels) {
      const idx = plainBody.indexOf(lbl);
      if (idx !== -1) {
        foundPositions.push({ key: sec.key, label: lbl, index: idx });
        break;
      }
    }
  }
  foundPositions.sort((a, b) => a.index - b.index);

  for (let i = 0; i < foundPositions.length; i++) {
    const curr = foundPositions[i];
    const next = foundPositions[i + 1];
    const sliceStart = curr.index + curr.label.length;
    const sliceEnd = next ? next.index : Math.min(plainBody.length, sliceStart + 3500);
    let chunk = plainBody.slice(sliceStart, sliceEnd).trim();

    // 첫 줄이나 괄호 안의 성경 구절 분리 (예: <마태 25,31-46> 또는 에제 34,11-17)
    const refMatch = chunk.match(/^[<\[\(]?\s*([가-힣0-9\s]{1,12}\d+,\d+[\d\-.,ㄱ-ㅎ]*)\s*[>\]\)]?/);
    if (refMatch && ['reading1', 'psalm', 'reading2', 'acclamation', 'gospel', 'communion'].includes(curr.key)) {
      readings[`${curr.key}_ref`] = refMatch[1].trim();
      chunk = chunk.slice(refMatch[0].length).trim();
    }

    readings[curr.key] = chunk.slice(0, 2500);
  }

  return {
    date: dateStr,
    source_url: sourceUrl,
    en_source_url: `https://www.catholic.org/bible/daily_reading/?select_date=${dateStr}`,
    raw_title: rawTitle,
    title: rawTitle,
    color,
    gospel_diff: false,
    ko_gospel_ref: readings.gospel_ref || '',
    en_gospel_ref: '',
    hymns,
    readings
  };
}

// 굿뉴스 응답 버퍼를 안전하게 디코딩하는 헬퍼
async function fetchGoodnewsHtml(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8'
    }
  });

  if (!response.ok) {
    throw new Error(`굿뉴스 서버 응답 오류 (HTTP ${response.status})`);
  }

  const arrayBuf = await response.arrayBuffer();
  let htmlText = new TextDecoder('utf-8').decode(arrayBuf);
  if (
    htmlText.toLowerCase().includes('charset=euc-kr') ||
    htmlText.toLowerCase().includes('charset=ks_c_5601-1987') ||
    htmlText.includes('\uFFFD')
  ) {
    try {
      htmlText = new TextDecoder('euc-kr').decode(arrayBuf);
    } catch (_) {
      // euc-kr 미지원 환경 폴백
    }
  }
  return htmlText;
}

// 월간 목록 HTML에서 선택한 날짜(YYYY-MM-DD)에 해당하는 고유 missaid 추출
function extractMissaIdForDate(listHtml, dateStr) {
  const escapedDate = dateStr.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  // 패턴 1: missaid=16941&gomonth=2026-11-22 또는 gomonth=2026-11-22&missaid=16941
  const directPatterns = [
    new RegExp(`missaid=(\\d+)[^"'<>]*?gomonth=${escapedDate}`, 'i'),
    new RegExp(`gomonth=${escapedDate}[^"'<>]*?missaid=(\\d+)`, 'i')
  ];
  for (const pat of directPatterns) {
    const m = listHtml.match(pat);
    if (m && m[1]) return m[1];
  }

  // 패턴 2: 날짜 텍스트(예: 2026-11-22 또는 11월 22일) 주변 400자 이내의 missaid 링크 탐색
  const [, mm, dd] = dateStr.split('-').map(Number);
  const dateAnchors = [
    dateStr,
    `${mm}월 ${dd}일`,
    `${String(mm).padStart(2, '0')}월 ${String(dd).padStart(2, '0')}일`,
    `>${dd}<`
  ];
  for (const anchor of dateAnchors) {
    const idx = listHtml.indexOf(anchor);
    if (idx !== -1) {
      const windowSlice = listHtml.slice(Math.max(0, idx - 250), Math.min(listHtml.length, idx + 450));
      const m = windowSlice.match(/missaid=(\d+)/i);
      if (m && m[1]) return m[1];
    }
  }
  return null;
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const dateParam = (event.queryStringParameters && event.queryStringParameters.date) || '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: '날짜 형식(YYYY-MM-DD)이 올바르지 않습니다.' })
      };
    }

    // 1단계: 해당 날짜의 굿뉴스 페이지 조회
    let targetUrl = `https://maria.catholic.or.kr/mi_pr/missa/missa.asp?menu=missa&gomonth=${dateParam}&missatype=DA`;
    let htmlText = await fetchGoodnewsHtml(targetUrl);

    // 2단계: 만약 1단계 페이지에 본문('제1독서' 또는 '복음')이 없거나 다른 날짜가 열렸다면,
    //        목록에서 해당 날짜의 고유 missaid를 찾아 상세 페이지를 한 번 더 조회
    const hasReadingContent = (htmlText.includes('제1독서') || htmlText.includes('독서')) && htmlText.includes('복음');
    const missaId = extractMissaIdForDate(htmlText, dateParam);

    if (missaId && (!hasReadingContent || !targetUrl.includes('missaid='))) {
      const detailUrl = `https://maria.catholic.or.kr/mi_pr/missa/missa.asp?menu=missa&missaid=${missaId}&gomonth=${dateParam}&missatype=DA`;
      const detailHtml = await fetchGoodnewsHtml(detailUrl);
      if (detailHtml.includes('복음')) {
        targetUrl = detailUrl;
        htmlText = detailHtml;
      }
    }

    const parsedData = parseGoodnewsHtml(htmlText, dateParam, targetUrl);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(parsedData)
    };
  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: error.message || '매일미사 데이터를 불러오는 중 오류가 발생했습니다.'
      })
    };
  }
};