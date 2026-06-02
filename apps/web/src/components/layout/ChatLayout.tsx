import { ConversationList } from "../sidebar/ConversationList";
import { ChatArea } from "../chat/ChatArea";
import { DebugPanel } from "../debug/DebugPanel";
import { useChatStore } from "@/stores/chat";

export function ChatLayout() {
    const isDebugOpen = useChatStore((s) => s.isDebugOpen);

    return (
        <div className="flex h-screen w-screen overflow-hidden">
            <ConversationList />
            <ChatArea />
            {isDebugOpen && <DebugPanel />}
        </div>
    );
}
