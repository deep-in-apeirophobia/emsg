package main

import (
	"fmt"
	"os"

	"github.com/gofiber/fiber/v2"

	"github.com/getsentry/sentry-go"
	sentryfiber "github.com/getsentry/sentry-go/fiber"

	handlers "msg.atrin.dev/mskas/handlers/socket"
	"msg.atrin.dev/mskas/routers"
)

func init_sentry(app *fiber.App) {

	if err := sentry.Init(sentry.ClientOptions{
		Dsn:              "https://fc4d733811b0a2d8781b4a649a713377@o4506240933429248.ingest.us.sentry.io/4509107679854592",
		TracesSampleRate: 1.0,
	}); err != nil {
		fmt.Printf("Sentry initialization failed: %v\n", err)
	}

	// Later in the code
	sentryHandler := sentryfiber.New(sentryfiber.Options{
		Repanic:         true,
		WaitForDelivery: true,
	})

	enhanceSentryEvent := func(ctx *fiber.Ctx) error {
		if hub := sentryfiber.GetHubFromContext(ctx); hub != nil {
			uid := ctx.Params("uid")
			if uid != "" {
				hub.Scope().SetTag("req-uid", uid)
			}
		}
		return ctx.Next()
	}

	app.Use(sentryHandler)

	app.All("/", enhanceSentryEvent)

	app.All("/", func(ctx *fiber.Ctx) error {
		if hub := sentryfiber.GetHubFromContext(ctx); hub != nil {
			hub.WithScope(func(scope *sentry.Scope) {
				scope.SetExtra("unwantedQuery", "someQueryDataMaybe")
				hub.CaptureMessage("User provided unwanted query string, but we recovered just fine")
			})
		}
		return ctx.SendStatus(fiber.StatusOK)
	})

}

func main() {
	workers := make(chan struct{}, 100)
	routers.SetWorkers(workers)

	go handlers.MessageLoop()

	app := fiber.New()

	// init_sentry(app)

	routers.SetupRouters(app)

	if err := app.Listen(":" + os.Getenv("PORT")); err != nil {
		panic(err)
	}
}
