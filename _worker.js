// _worker.js (v1.1)
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 1. 静态文件托管
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }
    
    const path = url.pathname;
    const db = env.DB;
    const bucket = env.BUCKET;
    
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // [GET] 获取书架列表 (修改：增加 sort_order 字段，按其倒序排列)
      if (path === '/api/books' && request.method === 'GET') {
        const { results } = await db.prepare(`
          SELECT id, name, word_count, total_chapters, total_paragraphs, 
                 progress_gidx, current_chapter_title, import_time, sort_order
          FROM books 
          ORDER BY sort_order DESC, import_time DESC
        `).all();
        return Response.json(results, { headers: corsHeaders });
      }

      // [POST] 导入新书 (修改：初始化 sort_order)
      if (path === '/api/books' && request.method === 'POST') {
        const data = await request.json();
        if (data.content && data.content.length > 10 * 1024 * 1024) {
          return new Response(JSON.stringify({ error: 'File content too large (Max 10MB)' }), { 
            status: 413, 
            headers: { 'Content-Type': 'application/json', ...corsHeaders } 
          });
        }

        const bookId = crypto.randomUUID(); 
        const r2_key = `txt/${bookId}.txt`;
        const chMapData = JSON.parse(data.chMap || '[]');
        const totalParagraphs = data.totalParagraphs || 0;
        const firstChapterTitle = (chMapData.length > 0 && chMapData[0].title) ? chMapData[0].title : '开始阅读';
        const now = Date.now(); // 获取当前时间戳

        await bucket.put(r2_key, data.content);
        
        await db.prepare(`
          INSERT INTO books (
            id, name, r2_key, word_count, total_chapters, total_paragraphs, 
            ch_map, current_chapter_title, import_time, sort_order
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
            bookId, data.name, r2_key, data.wordCount, data.totalChapters, 
            totalParagraphs, data.chMap, firstChapterTitle, now, now // sort_order 初始化为 now
        ).run();
        
        return Response.json({ success: true, id: bookId }, { headers: corsHeaders });
      }

      // [GET] 获取书籍详情
      const bookMatch = path.match(/^\/api\/books\/([^\/]+)$/);
      if (bookMatch && request.method === 'GET') {
        const id = decodeURIComponent(bookMatch[1]);
        const book = await db.prepare(`
            SELECT id, name, r2_key, word_count, total_chapters, total_paragraphs, 
                   progress_gidx, ch_map, current_chapter_title
            FROM books WHERE id = ?
          `).bind(id).first();
        if (!book) return new Response('Not found', { status: 404, headers: corsHeaders });
        return Response.json(book, { headers: corsHeaders });
      }
      
      // [DELETE] 删除书籍
      if (bookMatch && request.method === 'DELETE') {
        const id = decodeURIComponent(bookMatch[1]);
        const book = await db.prepare('SELECT r2_key FROM books WHERE id = ?').bind(id).first();
        if (!book) return new Response(JSON.stringify({ error: 'Book not found' }), { status: 404, headers: corsHeaders });
        
        await bucket.delete(book.r2_key);
        await db.prepare('DELETE FROM books WHERE id = ?').bind(id).run();
        return Response.json({ success: true }, { headers: corsHeaders });
      }

      // [GET] 获取书籍原始 TXT 内容
      const contentMatch = path.match(/^\/api\/books\/([^\/]+)\/content$/);
      if (contentMatch && request.method === 'GET') {
        const id = decodeURIComponent(contentMatch[1]);
        const book = await db.prepare('SELECT r2_key FROM books WHERE id = ?').bind(id).first();
        if (!book) return new Response('Not found', { status: 404 });
        const obj = await bucket.get(book.r2_key);
        if (!obj) return new Response('File not found in R2', { status: 404 });
        return new Response(obj.body, { 
          headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders } 
        });
      }

      // [PUT] 更新阅读进度
      const progressMatch = path.match(/^\/api\/books\/([^\/]+)\/progress$/);
      if (progressMatch && request.method === 'PUT') {
        const id = decodeURIComponent(progressMatch[1]);
        const data = await request.json();
        
        await db.prepare(`
          UPDATE books 
          SET progress_gidx = ?, current_chapter_title = ? 
          WHERE id = ?
        `).bind(data.progressGidx, data.currentChapterTitle, id).run();
        
        return Response.json({ success: true }, { headers: corsHeaders });
      }

      // [PUT] 置顶书籍 (v1.1 新增)
      const pinMatch = path.match(/^\/api\/books\/([^\/]+)\/pin$/);
      if (pinMatch && request.method === 'PUT') {
        const id = decodeURIComponent(pinMatch[1]);
        // 将 sort_order 设置为当前时间戳，这样它就会排在所有旧数据的前面
        const now = Date.now();
        await db.prepare(`UPDATE books SET sort_order = ? WHERE id = ?`).bind(now, id).run();
        return Response.json({ success: true }, { headers: corsHeaders });
      }

      return new Response('API Not Found', { status: 404, headers: corsHeaders });
      
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message, stack: err.stack }), { 
        status: 500, 
        headers: { 'Content-Type': 'application/json', ...corsHeaders } 
      });
    }
  }
};
