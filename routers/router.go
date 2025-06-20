package routers

import (
	"github.com/gofiber/fiber/v2/log"
	"html"

	"github.com/gofiber/contrib/websocket"
	"github.com/gofiber/fiber/v2"
	"msg.atrin.dev/mskas/helpers"
	"msg.atrin.dev/mskas/types"

	handlers "msg.atrin.dev/mskas/handlers/socket"

	"html/template"
)

var (
	workers  chan struct{} = nil
	sessions               = make(map[string]string)
)

var tpl *template.Template

func SetWorkers(wrs chan struct{}) {
	workers = wrs
}

func handleWebsocketReq(c *websocket.Conn) {
	roomid := c.Locals("ROOMID").(string)
	userid := c.Locals("USERID").(string)
	username := c.Locals("USERNAME").(string)
	// huid, err := hashuid(&uid)
	c.WriteMessage(websocket.TextMessage, []byte(`{"type": "joining"}`))

	cls, ok := handlers.GetClients(roomid)
	var cl *types.Client = nil
	for _, client := range cls {
		if *client.UserId == userid {
			cl = client
			break
		}
	}

	var conn *types.Connection

	if ok && cl != nil {
		conn = &types.Connection{Ws: c, IsClosing: false}
		cl.Conns = append(cl.Conns, conn)
	} else {
		conn = &types.Connection{Ws: c, IsClosing: false, UserId: &userid, UserName: &username}
		conns := make([]*types.Connection, 1)
		conns[0] = conn
		newclient := &types.Client{RoomID: &roomid, UserId: &userid, UserName: &username, Conns: conns}
		if ok {
			cls = append(cls, newclient)
			handlers.SetClients(roomid, cls)
		} else {
			handlers.CreateClientHUid(roomid)[0] = newclient
		}
	}

	cnn := handlers.NewConnectionContext(c, cl, conn, roomid, userid, username)

	cnn.HandleWsConn(workers)
}

type LoginParams struct {
	Username string `json:"username"`
	RoomID   string `json:"roomid"`
}

type LoginData struct {
	IsLoggedIn bool `json:"is_logged_in"`

	Username string `json:"username"`
	UserID   string `json:"user_id"`
	RoomID   string `json:"room_id"`

	Error        bool   `json:"error"`
	ErrorMessage string `json:"error_message"`
}

func loginHandler(c *fiber.Ctx) error {

	data := LoginParams{}

	err := c.BodyParser(&data)

	if err != nil {
		log.Error("Failed to process data", err)
		err := tpl.ExecuteTemplate(c.Response().BodyWriter(), "home", LoginData{
			Error:        true,
			ErrorMessage: "Invalid request",
		})
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).SendString(err.Error())
		}
		c.Set(fiber.HeaderContentType, fiber.MIMETextHTML)
		return nil
	}

	oldsessionId := c.Cookies("Session")

	oldusername, ok := sessions[oldsessionId]
	if oldsessionId != "" && ok {
		if data.RoomID != "" {
			return c.Redirect("/chat/"+data.RoomID, fiber.StatusFound)
		}
		err := tpl.ExecuteTemplate(c.Response().BodyWriter(), "home", LoginData{
			IsLoggedIn: true,
			Username:   oldusername,
			UserID:     oldsessionId,
		})
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).SendString(err.Error())
		}
		c.Set(fiber.HeaderContentType, fiber.MIMETextHTML)
		return nil
	}

	sessionId, err := helpers.GenerateSecureRandomString(24)

	if err != nil {
		log.Error("Failed to generate session", err)
		err := tpl.ExecuteTemplate(c.Response().BodyWriter(), "home", LoginData{
			Error:        true,
			ErrorMessage: "Invalid request",
		})
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).SendString(err.Error())
		}
		c.Set(fiber.HeaderContentType, fiber.MIMETextHTML)
		return nil
	}

	cookie := &fiber.Cookie{
		Name:  "Session",
		Value: sessionId,
	}
	c.Cookie(cookie)
	username := html.EscapeString(data.Username)
	sessions[sessionId] = username

	if data.RoomID != "" {
		return c.Redirect("/chat/"+data.RoomID, fiber.StatusFound)
	}
	errt := tpl.ExecuteTemplate(c.Response().BodyWriter(), "home", LoginData{
		IsLoggedIn: true,
		Username:   username,
		UserID:     sessionId,
	})
	if errt != nil {
		return c.Status(fiber.StatusInternalServerError).SendString(errt.Error())
	}
	c.Set(fiber.HeaderContentType, fiber.MIMETextHTML)
	return nil

}

func chatHandler(c *fiber.Ctx) error {

	roomid := c.Params("roomid")

	sessionid := c.Cookies("Session")

	username, ok := sessions[sessionid]
	if sessionid == "" || !ok {
		return c.Redirect("/", fiber.StatusFound)
	}

	err := tpl.ExecuteTemplate(c.Response().BodyWriter(), "chat", LoginData{
		IsLoggedIn: true,
		Username:   username,
		UserID:     sessionid,
		RoomID:     roomid,
	})
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).SendString(err.Error())
	}
	c.Set(fiber.HeaderContentType, fiber.MIMETextHTML)
	return nil

}

func homeHandler(c *fiber.Ctx) error {

	sessionid := c.Cookies("Session")

	username, ok := sessions[sessionid]
	if sessionid == "" || !ok {
		err := tpl.ExecuteTemplate(c.Response().BodyWriter(), "home", LoginData{
			IsLoggedIn: false,
		})
		if err != nil {
			return c.Status(fiber.StatusInternalServerError).SendString(err.Error())
		}
		c.Set(fiber.HeaderContentType, fiber.MIMETextHTML)
		return nil
	}

	err := tpl.ExecuteTemplate(c.Response().BodyWriter(), "home", LoginData{
		IsLoggedIn: true,
		Username:   username,
		UserID:     sessionid,
	})
	if err != nil {
		return c.Status(fiber.StatusInternalServerError).SendString(err.Error())
	}
	c.Set(fiber.HeaderContentType, fiber.MIMETextHTML)
	return nil

}

func SetupRouters(app *fiber.App) {
	tpl = template.Must(template.ParseGlob("templates/*.gohtml"))

	app.Static("/static", "./static")

	app.Post("/login", loginHandler)
	app.Post("/", loginHandler)
	app.Get("/", homeHandler)
	app.Get("/chat/:roomid", chatHandler)

	app.Use("/ws/:roomid", func(c *fiber.Ctx) error {
		sessionId := c.Cookies("Session")
		if sessionId == "" {
			return c.Redirect("/login")
		}
		username, ok := sessions[sessionId]

		if !ok {
			return c.Redirect("/login")
		}
		log.Info("Connection received")
		// if c.Get("host") == "localhost:4000" {
		// 	c.Locals("Host", "localhost:4000")
		// 	return c.Next()
		// }

		roomid := c.Params("roomid")

		c.Locals("ROOMID", roomid)
		c.Locals("USERID", sessionId)
		c.Locals("USERNAME", username)

		log.Info("Upgrading connection, ", roomid, sessionId)

		return c.Next()
	})

	app.Get("/ws/:uid", websocket.New(handleWebsocketReq))

}
