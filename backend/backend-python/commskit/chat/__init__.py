"""1:1 chat feature. Depends only on ``commskit.core``."""

from .dto import MessageRow, message_dto
from .feature import ChatConfig, ChatFeature
from .models import Chat, ChatCleared, Message, MessageHidden
from .policy import AllowAllChatPolicy, ChatPolicy
from .service import ChatActionError, ChatRow, ChatService

__all__ = [
    "AllowAllChatPolicy", "Chat", "ChatActionError", "ChatCleared", "ChatConfig", "ChatFeature", "ChatPolicy",
    "ChatRow", "ChatService", "Message", "MessageHidden", "MessageRow", "message_dto",
]
