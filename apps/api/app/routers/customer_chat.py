import json
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from app.schemas.customer_chat import CustomerChatRequest
from app.services.customer_chat_service import CustomerChatService

router = APIRouter(prefix="/api", tags=["customer-chat"])  

@router.post("/customer-chat") 
async def stream_chat(request: CustomerChatRequest):
    service = CustomerChatService()

    async def event_generator():
        try:
            async for chunk in service.stream_chat(request.message):
                 yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'content': str(e)})}\n\n"
    
    return StreamingResponse(event_generator(), media_type="text/event-stream",    headers={
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    },)