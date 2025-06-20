package types

import ()

type MessageType string

// Declare constants of the custom type with predefined values
const (
	MessageTypePing        MessageType = "PING"
	MessageTypePong        MessageType = "PONG"
	MessageTypeJoined      MessageType = "JOINED"
	MessageTypeLeft        MessageType = "LEFT"
	MessageTypeTextMessage MessageType = "TEXT_MESSAGE"
)

type Message struct {
	RoomID   string      `json:"room_id"`
	UserID   string      `json:"user_id"`
	UserName string      `json:"username"`
	Type     MessageType `json:"type"`
	Message  string      `json:"message"`
}
