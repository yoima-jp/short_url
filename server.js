const express = require('express');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const UAParser = require('ua-parser-js');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// ミドルウェア設定
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

// テンプレートエンジン設定
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// SQLite データベース初期化
const db = new sqlite3.Database('./shortener.db');

// テーブル作成
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS short_urls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE,
      original_url TEXT,
      password_hash TEXT,
      show_redirect_page INTEGER DEFAULT 1,
      title TEXT,
      description TEXT,
      favicon_url TEXT,
      og_image_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  
  // 既存のテーブルに新しいカラムを追加（エラーを無視）
  db.run(`ALTER TABLE short_urls ADD COLUMN title TEXT`, () => {});
  db.run(`ALTER TABLE short_urls ADD COLUMN description TEXT`, () => {});
  db.run(`ALTER TABLE short_urls ADD COLUMN favicon_url TEXT`, () => {});
  db.run(`ALTER TABLE short_urls ADD COLUMN og_image_url TEXT`, () => {});
  
  // 既存のデータでtitleがNULLの場合にoriginal_urlをtitleとして設定
  db.run(`UPDATE short_urls SET title = original_url WHERE title IS NULL OR title = ''`, (err) => {
    if (err) {
      console.log('Title update skipped:', err.message);
    } else {
      console.log('Updated empty titles with original URLs');
    }
  });
  
  db.run(`
    CREATE TABLE IF NOT EXISTS access_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      short_url_id INTEGER,
      accessed_at DATETIME,
      ip_address TEXT,
      user_agent TEXT,
      browser TEXT,
      os TEXT,
      device TEXT,
      language TEXT,
      timezone TEXT,
      referrer TEXT,
      screen_width INTEGER,
      screen_height INTEGER,
      color_depth INTEGER,
      pixel_depth INTEGER,
      viewport_width INTEGER,
      viewport_height INTEGER,
      available_screen_width INTEGER,
      available_screen_height INTEGER,
      orientation TEXT,
      pixel_ratio REAL,
      touch_support INTEGER,
      cookie_enabled INTEGER,
      java_enabled INTEGER,
      online_status INTEGER,
      platform TEXT,
      cpu_cores INTEGER,
      memory_gb REAL,
      connection_type TEXT,
      connection_downlink REAL,
      connection_rtt INTEGER,
      do_not_track TEXT,
      webgl_vendor TEXT,
      webgl_renderer TEXT,
      canvas_fingerprint TEXT,
      audio_fingerprint TEXT,
      plugins_list TEXT,
      fonts_list TEXT,
      local_storage_enabled INTEGER,
      session_storage_enabled INTEGER,
      indexed_db_enabled INTEGER,
      webrtc_support INTEGER,
      media_devices_count INTEGER,
      FOREIGN KEY(short_url_id) REFERENCES short_urls(id)
    );
  `);
});

// ランダムコード生成関数
function generateCode(length = 6) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// URLのメタ情報を取得する関数
async function fetchMetaInfo(url) {
  try {
    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    const $ = cheerio.load(response.data);
    
    const title = $('title').text().trim() || 
                  $('meta[property="og:title"]').attr('content') || 
                  $('meta[name="twitter:title"]').attr('content') || 
                  'タイトルなし';
    
    const description = $('meta[name="description"]').attr('content') || 
                       $('meta[property="og:description"]').attr('content') || 
                       $('meta[name="twitter:description"]').attr('content') || 
                       '';
    
    let faviconUrl = $('link[rel="icon"]').attr('href') || 
                     $('link[rel="shortcut icon"]').attr('href') || 
                     $('link[rel="apple-touch-icon"]').attr('href') || 
                     '/favicon.ico';
    
    // 相対URLを絶対URLに変換
    if (faviconUrl && !faviconUrl.startsWith('http')) {
      const urlObj = new URL(url);
      if (faviconUrl.startsWith('/')) {
        faviconUrl = urlObj.origin + faviconUrl;
      } else {
        faviconUrl = urlObj.origin + '/' + faviconUrl;
      }
    }
    
    let ogImageUrl = $('meta[property="og:image"]').attr('content') || 
                     $('meta[name="twitter:image"]').attr('content') || 
                     '';
    
    // OG画像も相対URLを絶対URLに変換
    if (ogImageUrl && !ogImageUrl.startsWith('http')) {
      const urlObj = new URL(url);
      if (ogImageUrl.startsWith('/')) {
        ogImageUrl = urlObj.origin + ogImageUrl;
      } else {
        ogImageUrl = urlObj.origin + '/' + ogImageUrl;
      }
    }
    
    return {
      title: title.substring(0, 255), // 長すぎる場合は切り詰め
      description: description.substring(0, 500),
      faviconUrl,
      ogImageUrl
    };
  } catch (error) {
    console.error('メタ情報取得エラー:', error.message);
    return {
      title: 'タイトル取得失敗',
      description: '',
      faviconUrl: '',
      ogImageUrl: ''
    };
  }
}

// ユニークコード生成と挿入
async function insertUniqueCode(originalUrl, passwordHash, showRedirectPage, callback) {
  const code = generateCode();
  
  try {
    // メタ情報を取得
    const metaInfo = await fetchMetaInfo(originalUrl);
    
    db.get(`SELECT id FROM short_urls WHERE code = ?`, [code], (err, row) => {
      if (err) return callback(err);
      if (row) {
        // 重複していたら再帰的にやり直す
        return insertUniqueCode(originalUrl, passwordHash, showRedirectPage, callback);
      }
      // 重複していなければ保存
      db.run(
        `INSERT INTO short_urls (code, original_url, password_hash, show_redirect_page, title, description, favicon_url, og_image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [code, originalUrl, passwordHash, showRedirectPage, metaInfo.title, metaInfo.description, metaInfo.faviconUrl, metaInfo.ogImageUrl],
        function(err2) {
          if (err2) return callback(err2);
          callback(null, code);
        }
      );
    });
  } catch (error) {
    console.error('メタ情報取得エラー:', error);
    // エラーが発生してもコード生成は続行
    db.get(`SELECT id FROM short_urls WHERE code = ?`, [code], (err, row) => {
      if (err) return callback(err);
      if (row) {
        return insertUniqueCode(originalUrl, passwordHash, showRedirectPage, callback);
      }
      db.run(
        `INSERT INTO short_urls (code, original_url, password_hash, show_redirect_page, title, description, favicon_url, og_image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [code, originalUrl, passwordHash, showRedirectPage, 'タイトル取得失敗', '', '', ''],
        function(err2) {
          if (err2) return callback(err2);
          callback(null, code);
        }
      );
    });
  }
}

// ルート設定

// ホーム画面
app.get('/', (req, res) => {
  res.render('index');
});

// 短縮URL作成
app.post('/create', async (req, res) => {
  const { original_url, password, show_redirect_page } = req.body;
  
  if (!original_url || !password) {
    return res.render('index', { error: 'URLとパスワードは必須です' });
  }
  
  // URL形式チェック
  try {
    new URL(original_url);
  } catch (e) {
    return res.render('index', { error: '有効なURLを入力してください' });
  }
  
  try {
    // パスワードをハッシュ化
    const passwordHash = await bcrypt.hash(password, 10);
    
    // リダイレクトページ表示設定（チェックされていれば1、されていなければ0）
    const showRedirectPageValue = show_redirect_page === 'on' ? 1 : 0;
    
    // ユニークコードを生成して保存
    try {
      await new Promise((resolve, reject) => {
        insertUniqueCode(original_url, passwordHash, showRedirectPageValue, (err, code) => {
          if (err) {
            reject(err);
          } else {
            const shortUrl = `${req.protocol}://${req.get('host')}/r/${code}`;
            const adminUrl = `${req.protocol}://${req.get('host')}/admin/${code}`;
            
            res.render('created', { 
              shortUrl, 
              adminUrl, 
              code,
              originalUrl: original_url 
            });
            resolve();
          }
        });
      });
    } catch (err) {
      console.error(err);
      return res.render('index', { error: 'サーバーエラーが発生しました' });
    }
  } catch (error) {
    console.error(error);
    res.render('index', { error: 'サーバーエラーが発生しました' });
  }
});

// 即座にリダイレクト時のログ記録関数（HTTPヘッダーのみの情報）
function logDirectRedirect(shortUrlId, req, callback) {
  // User-Agent解析
  const userAgent = req.headers['user-agent'] || '';
  const parser = new UAParser(userAgent);
  const result = parser.getResult();

  // IPアドレス取得
  let ipAddress = req.headers['x-forwarded-for'] || 
                 req.connection.remoteAddress || 
                 req.socket.remoteAddress ||
                 (req.connection.socket ? req.connection.socket.remoteAddress : null);
  
  if (ipAddress && ipAddress.includes(',')) {
    ipAddress = ipAddress.split(',')[0].trim();
  }

  // Accept-Language から主要言語を抽出
  const acceptLanguage = req.headers['accept-language'] || '';
  const primaryLanguage = acceptLanguage.split(',')[0] || 'Unknown';

  const logData = {
    short_url_id: shortUrlId,
    accessed_at: new Date().toISOString(),
    ip_address: ipAddress || 'unknown',
    user_agent: userAgent,
    browser: result.browser.name || 'Unknown',
    os: result.os.name || 'Unknown',
    device: result.device.type || 'Desktop',
    language: primaryLanguage,
    timezone: '', // HTTPヘッダーからは取得不可
    referrer: req.headers['referer'] || ''
  };

  db.run(
    `INSERT INTO access_logs (
      short_url_id, accessed_at, ip_address, user_agent, 
      browser, os, device, language, timezone, referrer
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      logData.short_url_id,
      logData.accessed_at,
      logData.ip_address,
      logData.user_agent,
      logData.browser,
      logData.os,
      logData.device,
      logData.language,
      logData.timezone,
      logData.referrer
    ],
    callback
  );
}

// リダイレクト処理（設定に応じてページ表示または即座にリダイレクト）
app.get('/r/:code', (req, res) => {
  const code = req.params.code;
  
  db.get(`SELECT * FROM short_urls WHERE code = ?`, [code], (err, row) => {
    if (err || !row) {
      return res.status(404).render('404');
    }
    
    // メタ情報のデフォルト値を設定
    const metaData = {
      code: code,
      originalUrl: row.original_url,
      title: row.title || row.original_url || 'リダイレクト',
      description: row.description || '',
      faviconUrl: row.favicon_url || '',
      ogImageUrl: row.og_image_url || ''
    };
    
    // リダイレクトページを表示するかどうかの設定をチェック
    if (row.show_redirect_page === 1) {
      // リダイレクトページを表示（従来通り）
      res.render('redirect', metaData);
    } else {
      // 即座にリダイレクト（HTTPヘッダー情報のみを記録して302リダイレクト）
      logDirectRedirect(row.id, req, (err) => {
        if (err) {
          console.error('ログ記録エラー:', err);
        }
        // ログ記録の成否に関わらず302リダイレクト
        res.redirect(302, row.original_url);
      });
    }
  });
});

// ログ記録エンドポイント
app.post('/log/:code', (req, res) => {
  const code = req.params.code;
  
  db.get(`SELECT id FROM short_urls WHERE code = ?`, [code], (err, row) => {
    if (err || !row) {
      return res.status(404).json({ error: 'Not found' });
    }

    // User-Agent解析
    const userAgent = req.body.userAgent || req.headers['user-agent'] || '';
    const parser = new UAParser(userAgent);
    const result = parser.getResult();

    // IPアドレス取得
    let ipAddress = req.headers['x-forwarded-for'] || 
                   req.connection.remoteAddress || 
                   req.socket.remoteAddress ||
                   (req.connection.socket ? req.connection.socket.remoteAddress : null);
    
    if (ipAddress && ipAddress.includes(',')) {
      ipAddress = ipAddress.split(',')[0].trim();
    }

    const logData = {
      short_url_id: row.id,
      accessed_at: new Date().toISOString(),
      ip_address: ipAddress || 'unknown',
      user_agent: userAgent,
      browser: result.browser.name || 'Unknown',
      os: result.os.name || 'Unknown',
      device: req.body.device || result.device.type || 'Desktop',
      language: req.body.language || req.headers['accept-language'] || '',
      timezone: req.body.timezone || '',
      referrer: req.body.referrer || req.headers['referer'] || '',
      screen_width: req.body.screenWidth || null,
      screen_height: req.body.screenHeight || null,
      color_depth: req.body.colorDepth || null,
      pixel_depth: req.body.pixelDepth || null,
      viewport_width: req.body.viewportWidth || null,
      viewport_height: req.body.viewportHeight || null,
      available_screen_width: req.body.availableScreenWidth || null,
      available_screen_height: req.body.availableScreenHeight || null,
      orientation: req.body.orientation || '',
      pixel_ratio: req.body.pixelRatio || null,
      touch_support: req.body.touchSupport ? 1 : 0,
      cookie_enabled: req.body.cookieEnabled ? 1 : 0,
      java_enabled: req.body.javaEnabled ? 1 : 0,
      online_status: req.body.onlineStatus ? 1 : 0,
      platform: req.body.platform || '',
      cpu_cores: req.body.cpuCores || null,
      memory_gb: req.body.memoryGb || null,
      connection_type: req.body.connectionType || '',
      connection_downlink: req.body.connectionDownlink || null,
      connection_rtt: req.body.connectionRtt || null,
      do_not_track: req.body.doNotTrack || '',
      webgl_vendor: req.body.webglVendor || '',
      webgl_renderer: req.body.webglRenderer || '',
      canvas_fingerprint: req.body.canvasFingerprint || '',
      audio_fingerprint: req.body.audioFingerprint || '',
      plugins_list: req.body.pluginsList || '',
      fonts_list: req.body.fontsList || '',
      local_storage_enabled: req.body.localStorageEnabled ? 1 : 0,
      session_storage_enabled: req.body.sessionStorageEnabled ? 1 : 0,
      indexed_db_enabled: req.body.indexedDbEnabled ? 1 : 0,
      webrtc_support: req.body.webrtcSupport ? 1 : 0,
      media_devices_count: req.body.mediaDevicesCount || null
    };

    db.run(
      `INSERT INTO access_logs (
        short_url_id, accessed_at, ip_address, user_agent, 
        browser, os, device, language, timezone, referrer,
        screen_width, screen_height, color_depth, pixel_depth,
        viewport_width, viewport_height, available_screen_width, available_screen_height,
        orientation, pixel_ratio, touch_support, cookie_enabled, java_enabled, online_status,
        platform, cpu_cores, memory_gb, connection_type, connection_downlink, connection_rtt,
        do_not_track, webgl_vendor, webgl_renderer, canvas_fingerprint, audio_fingerprint,
        plugins_list, fonts_list, local_storage_enabled, session_storage_enabled, 
        indexed_db_enabled, webrtc_support, media_devices_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        logData.short_url_id, logData.accessed_at, logData.ip_address, logData.user_agent,
        logData.browser, logData.os, logData.device, logData.language, logData.timezone, logData.referrer,
        logData.screen_width, logData.screen_height, logData.color_depth, logData.pixel_depth,
        logData.viewport_width, logData.viewport_height, logData.available_screen_width, logData.available_screen_height,
        logData.orientation, logData.pixel_ratio, logData.touch_support, logData.cookie_enabled, 
        logData.java_enabled, logData.online_status, logData.platform, logData.cpu_cores, logData.memory_gb,
        logData.connection_type, logData.connection_downlink, logData.connection_rtt, logData.do_not_track,
        logData.webgl_vendor, logData.webgl_renderer, logData.canvas_fingerprint, logData.audio_fingerprint,
        logData.plugins_list, logData.fonts_list, logData.local_storage_enabled, logData.session_storage_enabled,
        logData.indexed_db_enabled, logData.webrtc_support, logData.media_devices_count
      ],
      (err) => {
        if (err) {
          console.error('ログ記録エラー:', err);
        }
        res.json({ success: true });
      }
    );
  });
});

// 管理画面 - ログイン画面表示
app.get('/admin/:code', (req, res) => {
  res.render('admin_login', { 
    code: req.params.code, 
    error: null 
  });
});

// 管理画面 - ログイン処理とダッシュボード表示
app.post('/admin/:code', async (req, res) => {
  const code = req.params.code;
  const inputPassword = req.body.password;
  
  if (!inputPassword) {
    return res.render('admin_login', { 
      code, 
      error: 'パスワードを入力してください' 
    });
  }
  
  db.get(`SELECT * FROM short_urls WHERE code = ?`, [code], async (err, row) => {
    if (err || !row) {
      return res.status(404).render('404');
    }
    
    try {
      const match = await bcrypt.compare(inputPassword, row.password_hash);
      if (!match) {
        return res.render('admin_login', { 
          code, 
          error: 'パスワードが間違っています' 
        });
      }
      
      // アクセスログを取得
      db.all(
        `SELECT * FROM access_logs WHERE short_url_id = ? ORDER BY accessed_at DESC`,
        [row.id],
        (err2, logs) => {
          if (err2) {
            console.error(err2);
            return res.status(500).send('ログ取得に失敗しました');
          }
          
          // 統計情報を計算
          const stats = calculateStats(logs);
          
          res.render('admin_dashboard', { 
            entry: row, 
            logs, 
            stats,
            code 
          });
        }
      );
    } catch (error) {
      console.error(error);
      res.render('admin_login', { 
        code, 
        error: 'サーバーエラーが発生しました' 
      });
    }
  });
});

// 統計情報計算関数
function calculateStats(logs) {
  const stats = {
    totalAccess: logs.length,
    browsers: {},
    os: {},
    devices: {},
    countries: {},
    dailyAccess: {},
    screenResolutions: {},
    orientations: {},
    platforms: {},
    connectionTypes: {},
    touchDevices: 0,
    cookieEnabled: 0,
    javaEnabled: 0,
    webrtcSupport: 0,
    averagePixelRatio: 0,
    topPlugins: {},
    topFonts: {},
    storageSupport: {
      localStorage: 0,
      sessionStorage: 0,
      indexedDB: 0
    }
  };
  
  let pixelRatioSum = 0;
  let pixelRatioCount = 0;
  
  logs.forEach(log => {
    // 基本統計
    stats.browsers[log.browser] = (stats.browsers[log.browser] || 0) + 1;
    stats.os[log.os] = (stats.os[log.os] || 0) + 1;
    stats.devices[log.device] = (stats.devices[log.device] || 0) + 1;
    
    // 日別アクセス統計
    const date = new Date(log.accessed_at).toISOString().split('T')[0];
    stats.dailyAccess[date] = (stats.dailyAccess[date] || 0) + 1;
    
    // 画面解像度統計
    if (log.screen_width && log.screen_height) {
      const resolution = `${log.screen_width}x${log.screen_height}`;
      stats.screenResolutions[resolution] = (stats.screenResolutions[resolution] || 0) + 1;
    }
    
    // デバイス方向統計
    if (log.orientation) {
      stats.orientations[log.orientation] = (stats.orientations[log.orientation] || 0) + 1;
    }
    
    // プラットフォーム統計
    if (log.platform) {
      stats.platforms[log.platform] = (stats.platforms[log.platform] || 0) + 1;
    }
    
    // 接続タイプ統計
    if (log.connection_type && log.connection_type !== 'Unknown') {
      stats.connectionTypes[log.connection_type] = (stats.connectionTypes[log.connection_type] || 0) + 1;
    }
    
    // 機能サポート統計
    if (log.touch_support) stats.touchDevices++;
    if (log.cookie_enabled) stats.cookieEnabled++;
    if (log.java_enabled) stats.javaEnabled++;
    if (log.webrtc_support) stats.webrtcSupport++;
    
    // ピクセル比平均計算
    if (log.pixel_ratio && log.pixel_ratio > 0) {
      pixelRatioSum += parseFloat(log.pixel_ratio);
      pixelRatioCount++;
    }
    
    // プラグイン統計
    if (log.plugins_list && log.plugins_list !== 'None' && log.plugins_list !== '') {
      const plugins = log.plugins_list.split(',');
      plugins.forEach(plugin => {
        if (plugin.trim()) {
          stats.topPlugins[plugin.trim()] = (stats.topPlugins[plugin.trim()] || 0) + 1;
        }
      });
    }
    
    // フォント統計
    if (log.fonts_list && log.fonts_list !== 'None detected' && log.fonts_list !== 'Detection failed') {
      const fonts = log.fonts_list.split(',');
      fonts.forEach(font => {
        if (font.trim()) {
          stats.topFonts[font.trim()] = (stats.topFonts[font.trim()] || 0) + 1;
        }
      });
    }
    
    // ストレージサポート統計
    if (log.local_storage_enabled) stats.storageSupport.localStorage++;
    if (log.session_storage_enabled) stats.storageSupport.sessionStorage++;
    if (log.indexed_db_enabled) stats.storageSupport.indexedDB++;
  });
  
  // ピクセル比平均計算
  stats.averagePixelRatio = pixelRatioCount > 0 ? (pixelRatioSum / pixelRatioCount).toFixed(2) : 0;
  
  return stats;
}

// 404ページ
app.use((req, res) => {
  res.status(404).render('404');
});

// サーバー開始
process.env.PORT || 3001(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

// プロセス終了時にDBを閉じる
process.on('SIGINT', () => {
  db.close((err) => {
    if (err) {
      console.error(err.message);
    }
    console.log('Database connection closed.');
    process.exit(0);
  });
});
