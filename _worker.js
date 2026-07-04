// _worker.js
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
      // [GET] 获取书架列表 (优化：仅返回必要字段，移除 ch_map)
      if (path === '/api/books' && request.method === 'GET') {
        const { results } = await db.prepare(`
          SELECT id, name, word_count, total_chapters, total_paragraphs, 
                 progress_gidx, current_chapter_title, import_time 
          FROM books 
          ORDER BY import_time DESC
        `).all();
        return Response.json(results, { headers: corsHeaders });
      }

      // [POST] 导入新书 (优化：后端生成 UUID，存储更多元数据)
      if (path === '/api/books' && request.method === 'POST') {
        const data = await request.json();
        
        // 安全限制
        if (data.content && data.content.length > 10 * 1024 * 1024) {
          return new Response(JSON.stringify({ error: 'File content too large (Max 10MB)' }), { 
            status: 413, 
            headers: { 'Content-Type': 'application/json', ...corsHeaders } 
          });
        }

        // 1. 后端生成唯一 ID 和 R2 Key
        const bookId = crypto.randomUUID(); 
        const r2_key = `txt/${bookId}.txt`;

        // 2. 解析元数据
        const chMapData = JSON.parse(data.chMap || '[]');
        const totalParagraphs = data.totalParagraphs || 0; // 前端计算后传过来
        const firstChapterTitle = (chMapData.length > 0 && chMapData[0].title) ? chMapData[0].title : '开始阅读';

        // 3. 存入 R2
        await bucket.put(r2_key, data.content);
        
        // 4. 存入 D1
        await db.prepare(`
          INSERT INTO books (
            id, name, r2_key, word_count, total_chapters, total_paragraphs, 
            ch_map, current_chapter_title, import_time
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
            bookId, 
            data.name, 
            r2_key, 
            data.wordCount, 
            data.totalChapters, 
            totalParagraphs,
            data.chMap, 
            firstChapterTitle,
            Date.now()
        ).run();
        
        // 返回生成的 ID
        return Response.json({ success: true, id: bookId }, { headers: corsHeaders });
      }

      // [GET] 获取书籍详情 (包含 ch_map，仅打开一本书时调用)
      const bookMatch = path.match(/^\/api\/books\/([^\/]+)$/);
      if (bookMatch && request.method === 'GET') {
        const id = decodeURIComponent(bookMatch[1]);
        const book = await db.prepare(`
            SELECT id, name, r2_key, word_count, total_chapters, total_paragraphs, 
                   progress_gidx, scroll_top, ch_map, current_chapter_title
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

      // [PUT] 更新阅读进度 (优化：同时更新当前章节标题)
      const progressMatch = path.match(/^\/api\/books\/([^\/]+)\/progress$/);
      if (progressMatch && request.method === 'PUT') {
        const id = decodeURIComponent(progressMatch[1]);
        const data = await request.json();
        
        await db.prepare(`
          UPDATE books 
          SET progress_gidx = ?, scroll_top = ?, current_chapter_title = ? 
          WHERE id = ?
        `).bind(
            data.progressGidx, 
            data.scrollTop, 
            data.currentChapterTitle, 
            id
        ).run();
        
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
