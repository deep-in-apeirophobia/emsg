package socket

import (
	"bytes"
	"slices"

	"github.com/gofiber/contrib/websocket"
	"github.com/gofiber/fiber/v2/log"
	"msg.atrin.dev/mskas/types"

	"encoding/json"
	"html"
	"text/template"
)

var (
	joinTemp  *template.Template
	leaveTemp *template.Template
)

func executeTemplate(temp *template.Template, data any) (string, error) {
	var buffer bytes.Buffer

	err := temp.Execute(&buffer, data)
	if err != nil {
		return "", err
	}

	ret := buffer.String()
	return ret, nil
}

type connectionContext struct {
	c        *websocket.Conn
	cl       *types.Client
	conn     *types.Connection
	roomid   string
	userid   string
	username string
}

type ConnectionInterface interface {
	SendMessage(msg *types.Message) error
	HandleWsConn(msg *types.Message) error
}

func NewConnectionContext(
	c *websocket.Conn,
	cl *types.Client,
	conn *types.Connection,
	roomid string,
	userid string,
	username string,
) *connectionContext {
	return &connectionContext{
		c:        c,
		cl:       cl,
		conn:     conn,
		roomid:   roomid,
		userid:   userid,
		username: username,
	}
}

func (c *connectionContext) sendJoinMessage() error {
	if joinTemp == nil {
		join_tmpl, err := template.New("joinTemplate").Parse("{{.username}}({{.userid | truncate 7}}) joined the chat!")

		joinTemp = join_tmpl

		if err != nil {
			log.Error("Failed to parse join message template", c, err)
			return err
		}
	}
	msg, err := executeTemplate(joinTemp, c)

	if err != nil {
		log.Error("Failed to generate join message", c, err)
		return err
	}
	join_msg := types.Message{
		Type:    types.MessageTypeJoined,
		Message: msg,
	}

	return c.SendMessage(&join_msg)
}

func (c *connectionContext) sendLeaveMessage() error {
	if joinTemp == nil {
		leave_tmpl, err := template.New("leaveTemplate").Parse("{{.username}}({{.userid | truncate 7}}) left the chat!")

		leaveTemp = leave_tmpl

		if err != nil {
			log.Error("Failed to parse leave message template", c, err)
			return err
		}
	}
	msg, err := executeTemplate(leaveTemp, c)

	if err != nil {
		log.Error("Failed to generate leave message", c, err)
		return err
	}
	join_msg := types.Message{
		Type:    types.MessageTypeJoined,
		Message: msg,
	}

	return c.SendMessage(&join_msg)
}

func (c *connectionContext) SendMessage(msg *types.Message) error {
	msg.RoomID = c.roomid
	msg.UserID = c.userid
	msg.UserName = c.username
	msg.Message = html.EscapeString(msg.Message)

	GetMessageTunnel() <- msg
	return nil
}

func (c *connectionContext) HandleWsConn(
	workers chan struct{},
) error {
	workers <- struct{}{}
	defer func() {
		log.Info("Closing connection", c.roomid, c.userid)
		c.cl.Conns = slices.DeleteFunc(c.cl.Conns, func(x *types.Connection) bool {
			return x.IsClosing
		})
		log.Info("Removed from list")
		c.c.Close()
		log.Info("closed")

		c.sendLeaveMessage()
		log.Info("Messasge sent")

		<-workers
	}()

	c.c.SetCloseHandler(func(code int, text string) error {
		c.conn.IsClosing = true
		return nil
	})

	c.sendJoinMessage()

	log.Debug("Handler", c)
	for {
		msgt, data, err := c.c.ReadMessage()

		if err != nil {
			log.Error("Failed to read message", c, err)
			return err
		}
		var msg types.Message
		if msgt == websocket.TextMessage {
			err := json.Unmarshal(data, &msg)
			if err != nil {
				log.Error("Failed to parse message", c, err, err.Error())
				continue
			}
		} else if msgt == websocket.BinaryMessage {
		}

		if msg.Type == types.MessageTypePing {
			c.c.WriteJSON(types.Message{
				Type: types.MessageTypePong,
			})
			continue
		}

		c.SendMessage(&msg)
	}
	return nil
}
