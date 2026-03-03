/**
 * /api/internal/refresh-kb endpoint
 * 
 * Dashboard calls this endpoint after updating KB in Supabase
 * Triggers instant KB synchronization in the container
 * 
 * SECURITY: Only accepts requests with Bearer token matching internal_secret
 */

import { refreshKnowledgeBase } from './refresh-knowledge-base';

export async function handleKBRefreshWebhook(
  request: Request,
  internalSecret: string
): Promise<Response> {
  // Verify auth
  const authHeader = request.headers.get('authorization');
  
  if (authHeader !== `Bearer ${internalSecret}`) {
    console.warn('Unauthorized KB refresh attempt');
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    console.log('KB refresh webhook received, refreshing knowledge base...');
    
    const result = await refreshKnowledgeBase();
    
    if (result.success) {
      console.log(`KB refreshed successfully: source=${result.source}`);
      return new Response(
        JSON.stringify({ 
          success: true, 
          message: 'KB refreshed successfully',
          source: result.source 
        }),
        { 
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    } else {
      console.error('KB refresh failed:', result.error);
      return new Response(
        JSON.stringify({ 
          success: false, 
          error: result.error || 'Refresh failed'
        }),
        { 
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }
  } catch (error) {
    console.error('KB refresh webhook error:', error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error'
      }),
      { 
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
}

// ============ EXPRESS ROUTE HANDLER (for NanoClaw container) ============

/*
// In your Express app:
app.post('/api/internal/refresh-kb', (req, res) => {
  handleKBRefreshWebhook(req, process.env.INTERNAL_REFRESH_SECRET!).then(response => {
    res.status(response.status).send(response.body);
  });
});
*/
