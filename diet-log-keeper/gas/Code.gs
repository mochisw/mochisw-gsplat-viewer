/**
 * Diet Log Keeper — Google Apps Script backend
 *
 * データの正本は Google Sheets（シート名: log）。
 * このスクリプトは、
 *   - スマホ用入力フォーム（doGet）
 *   - ログ保存 + 派生値計算（saveLog）
 *   - 全期間グラフページ（doGet?page=chart）
 * を提供する。
 */

var SHEET_NAME = 'log';

var HEADERS = [
  'date',
  'timing',
  'weight_kg',
  'body_fat_percent',
  'condition',
  'note',
  'created_at',
  'weight_change_from_previous',
  'body_fat_change_from_previous',
  'weight_7_record_avg',
  'body_fat_7_record_avg'
];

var TIMINGS = ['morning', 'before dinner', 'after dinner', 'after bath', 'before sleep', 'unknown'];
var CONDITIONS = ['normal', 'tired', 'poor sleep', 'travel', 'outing', 'drinking', 'ate out', 'exercise', 'sick', 'stressed'];

var AVG_WINDOW = 7; // 直近7「件」（7日ではない）

// ---------------------------------------------------------------- Web entry

function doGet(e) {
  var page = (e && e.parameter && e.parameter.page) === 'chart' ? 'Chart' : 'Form';
  return HtmlService.createHtmlOutputFromFile(page)
    .setTitle(page === 'Chart' ? 'Diet Log Keeper — Charts' : 'Diet Log Keeper')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1');
}

// ------------------------------------------------------------------- Setup

/** 初回に一度だけエディタから実行する。log シートとヘッダー行を作る。 */
function setupSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  }
  sheet.setFrozenRows(1);
  // date / created_at は文字列として保存する（タイムゾーンや自動変換の事故を避ける）
  sheet.getRange('A:A').setNumberFormat('@');
  sheet.getRange('G:G').setNumberFormat('@');
  sheet.getRange('C:C').setNumberFormat('0.0');
  sheet.getRange('D:D').setNumberFormat('0.0');
  sheet.getRange('H:K').setNumberFormat('0.00');
  sheet.autoResizeColumns(1, HEADERS.length);
}

function getSheet_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('シート "' + SHEET_NAME + '" がありません。setupSheet() を先に実行してください。');
  return sheet;
}

// -------------------------------------------------------------------- Save

/**
 * フォームから呼ばれる。1件保存し、分析結果を返す。
 * input: { date:'YYYY-MM-DD', timing, weightKg, bodyFatPercent, condition:[...], note }
 */
function saveLog(input) {
  var date = String(input.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date は YYYY-MM-DD 形式で入力してください。');

  var timing = String(input.timing || '').trim();
  if (TIMINGS.indexOf(timing) === -1) throw new Error('timing の値が不正です: ' + timing);

  var weight = Number(input.weightKg);
  if (!isFinite(weight) || weight < 20 || weight > 300) throw new Error('weight_kg は 20〜300 の範囲で入力してください。');

  var bodyFat = Number(input.bodyFatPercent);
  if (!isFinite(bodyFat) || bodyFat < 1 || bodyFat > 75) throw new Error('body_fat_percent は 1〜75 の範囲で入力してください。');

  var condition = (input.condition || [])
    .filter(function (c) { return CONDITIONS.indexOf(c) !== -1; })
    .join(', ');
  var note = String(input.note || '').trim();

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet_();
    var prevRecords = readRecords_(sheet).slice(-(AVG_WINDOW - 1)); // 直近6件（今回分と合わせて7件）
    var prev = prevRecords.length ? prevRecords[prevRecords.length - 1] : null;

    var weightDelta = prev ? round2_(weight - prev.weight) : '';
    var bodyFatDelta = prev ? round2_(bodyFat - prev.bodyFat) : '';

    var windowW = prevRecords.map(function (r) { return r.weight; }).concat([weight]);
    var windowF = prevRecords.map(function (r) { return r.bodyFat; }).concat([bodyFat]);
    var avgWeight = round2_(mean_(windowW));
    var avgBodyFat = round2_(mean_(windowF));

    var createdAt = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');

    sheet.appendRow([date, timing, weight, bodyFat, condition, note, createdAt,
      weightDelta, bodyFatDelta, avgWeight, avgBodyFat]);

    return {
      date: date,
      timing: timing,
      weightKg: weight,
      bodyFatPercent: bodyFat,
      weightDelta: weightDelta === '' ? null : weightDelta,
      bodyFatDelta: bodyFatDelta === '' ? null : bodyFatDelta,
      weightAvg: avgWeight,
      bodyFatAvg: avgBodyFat,
      avgCount: windowW.length,
      comment: buildComment_({
        timing: timing,
        condition: condition,
        weightDelta: weightDelta === '' ? null : weightDelta,
        bodyFatDelta: bodyFatDelta === '' ? null : bodyFatDelta,
        avgCount: windowW.length
      }),
      logLine: date + '  ' + weight.toFixed(1) + 'kg  ' + bodyFat.toFixed(1) + '%'
    };
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- Analysis

/**
 * 短い見立て（日本語）。断定を避け、事実と推察を分ける。
 * 詳細な分析は Claude Project 側に任せ、ここでは機械的に言える範囲に留める。
 */
function buildComment_(ctx) {
  var parts = [];
  var conditions = ctx.condition ? ctx.condition.split(', ') : [];
  var needsCare = ['tired', 'poor sleep', 'sick', 'stressed'].some(function (c) {
    return conditions.indexOf(c) !== -1;
  });

  if (needsCare) {
    parts.push('体調メモを見る限り消耗がありそうです。数字より先に休養を優先してください。');
  }

  if (ctx.weightDelta === null) {
    parts.push('初回の記録です。比較はデータが貯まってからにします。');
  } else {
    var d = ctx.weightDelta;
    var abs = Math.abs(d);
    if (abs >= 0.6) {
      parts.push('前回比 ' + signed_(d) + 'kg は単日の変動としては大きめですが、水分・食事内容・胃腸内容物の影響が大きい可能性があり、脂肪の増減とは切り分けて見るのが妥当です。');
    } else if (abs >= 0.3) {
      parts.push('前回比 ' + signed_(d) + 'kg。日常的な変動の範囲内と見てよさそうです。');
    } else {
      parts.push('前回比 ' + signed_(d) + 'kg で、ほぼ横ばいです。');
    }
  }

  if (ctx.timing === 'after dinner' || ctx.timing === 'after bath') {
    parts.push('なお「' + ctx.timing + '」の計測は条件的に重く（体脂肪率は水分で振れやすく）出やすい点は割り引いて見てください。');
  }

  if (ctx.avgCount < AVG_WINDOW) {
    parts.push('（7件平均はまだ' + ctx.avgCount + '件分の暫定値です）');
  }

  return parts.join(' ');
}

// -------------------------------------------------------------------- Read

/** グラフページ用。全レコードを返す。 */
function getChartData() {
  var records = readRecords_(getSheet_());
  return {
    records: records.map(function (r) {
      return {
        date: r.date,
        weight: r.weight,
        bodyFat: r.bodyFat,
        weightAvg: r.weightAvg,
        bodyFatAvg: r.bodyFatAvg
      };
    })
  };
}

function readRecords_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
  return values
    .filter(function (row) { return row[0] !== '' && row[2] !== '' && row[3] !== ''; })
    .map(function (row) {
      return {
        date: normalizeDate_(row[0]),
        timing: row[1],
        weight: Number(row[2]),
        bodyFat: Number(row[3]),
        weightAvg: row[9] === '' ? null : Number(row[9]),
        bodyFatAvg: row[10] === '' ? null : Number(row[10])
      };
    });
}

// ------------------------------------------------------------ Maintenance

/**
 * 手動で行を修正・追記・削除したあとに実行する。
 * date, created_at 順に並べ直し、H〜K列（前回比・7件平均）を全行再計算する。
 */
function recalcAll() {
  var sheet = getSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var rows = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues()
    .filter(function (row) { return row[0] !== ''; });

  rows.sort(function (a, b) {
    var ka = normalizeDate_(a[0]) + ' ' + a[6];
    var kb = normalizeDate_(b[0]) + ' ' + b[6];
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  var weights = [];
  var fats = [];
  rows.forEach(function (row, i) {
    var w = Number(row[2]);
    var f = Number(row[3]);
    row[0] = normalizeDate_(row[0]);
    row[7] = i === 0 ? '' : round2_(w - weights[weights.length - 1]);
    row[8] = i === 0 ? '' : round2_(f - fats[fats.length - 1]);
    weights.push(w);
    fats.push(f);
    row[9] = round2_(mean_(weights.slice(-AVG_WINDOW)));
    row[10] = round2_(mean_(fats.slice(-AVG_WINDOW)));
  });

  sheet.getRange(2, 1, lastRow - 1, HEADERS.length).clearContent();
  sheet.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
}

// ------------------------------------------------------------------- Utils

function normalizeDate_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v).trim();
}

function mean_(arr) {
  return arr.reduce(function (a, b) { return a + b; }, 0) / arr.length;
}

function round2_(n) {
  return Math.round(n * 100) / 100;
}

function signed_(n) {
  return (n > 0 ? '+' : '') + n.toFixed(2).replace(/0$/, '');
}
