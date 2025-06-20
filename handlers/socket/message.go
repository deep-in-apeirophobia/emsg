package socket

import (
	"github.com/gofiber/contrib/websocket"
	"github.com/gofiber/fiber/v2/log"
	"msg.atrin.dev/mskas/types"

	"encoding/json"
)

var (
	tunnel  = make(chan *types.Message)
	clients = make(map[string][]*types.Client)
)

func GetMessageTunnel() chan *types.Message {
	return tunnel
}

func GetClients(roomid string) ([]*types.Client, bool) {
	log.Debug("Getting client", roomid, " ", clients)
	cls, ok := clients[roomid]
	return cls, ok
}

func SetClients(roomid string, cls []*types.Client) {
	clients[roomid] = cls
}

func CreateClientHUid(roomid string) []*types.Client {
	clients[roomid] = make([]*types.Client, 1)
	return clients[roomid]
}

func inform_connections(cl *types.Client, dataBytes []byte) error {
	cl.Mu.Lock()
	defer cl.Mu.Unlock()

	for _, cn := range cl.Conns {
		if cn.IsClosing {
			continue
		}

		cn.Ws.WriteMessage(websocket.TextMessage, dataBytes)
	}
	return nil
}

func MessageLoop() {
	for {
		msg, ok := <-tunnel

		if !ok {
			return
		}

		dataBytes, err := json.Marshal(msg)
		if err != nil {
			log.Error("Failed to marshal message", err)
		}

		log.Info("Message recieved", *&msg.RoomID, msg.UserID, msg.UserName)

		cls, ok := clients[msg.RoomID]

		if !ok {
			continue
		}
		log.Info("Broadcasting message to ", len(cls))

		for _, c := range cls {
			err := inform_connections(c, dataBytes)

			if err != nil {
				log.Error("Failed inform connections", err)
			}
		}
	}
}
