package types

import (
	"github.com/gofiber/contrib/websocket"
	"sync"
)

type Connection struct {
	Ws        *websocket.Conn
	UserId    *string
	UserName  *string
	IsClosing bool
}

type Client struct {
	RoomID   *string
	UserId   *string
	UserName *string
	Mu       sync.Mutex

	Conns []*Connection
}
