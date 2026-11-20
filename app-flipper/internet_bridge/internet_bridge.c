/*
 * Puente Internet — app para Flipper Zero.
 *
 * Se abre en modo RPC desde la app "Flipper Puente" del celular (Bluetooth)
 * o desde "Flipper Puente PC" (USB). El Flipper le pide datos al equipo con
 * mensajes de texto y el equipo responde usando su conexión a internet.
 *
 * Protocolo (bytes UTF-8 dentro de PB_App.DataExchangeRequest):
 *   Flipper -> celular:  "GET <url>"      pedir una URL (texto plano o HTML)
 *                        "HELLO"          avisar que la app está lista
 *   Celular -> Flipper:  "OK <código>\n<cuerpo>"   respuesta HTTP resumida
 *                        "ERR <mensaje>"           error
 *                        "MSG <texto>"             mensaje libre desde el celular
 */

#include <furi.h>
#include <gui/gui.h>
#include <gui/view_dispatcher.h>
#include <gui/modules/submenu.h>
#include <gui/modules/text_box.h>
#include <gui/modules/text_input.h>
#include <notification/notification_messages.h>
#include <rpc/rpc_app.h>

#include <stdio.h>
#include <string.h>

#define TAG          "InternetBridge"
#define RX_MAX       2048
#define URL_MAX      96
#define REPLY_TIMEOUT_MS 20000

typedef enum {
    ViewMenu,
    ViewText,
    ViewInput,
} ViewId;

typedef enum {
    EvRxData = 100,
    EvExit,
    EvSessionClosed,
    EvUrlEntered,
    EvTimeout,
} CustomEvent;

typedef enum {
    MenuIp,
    MenuClima,
    MenuChiste,
    MenuUrl,
    MenuUltima,
} MenuItem;

typedef struct {
    Gui* gui;
    ViewDispatcher* view_dispatcher;
    Submenu* menu;
    TextBox* text_box;
    TextInput* text_input;
    NotificationApp* notifications;

    RpcAppSystem* rpc;
    FuriMutex* rx_mutex;
    char rx[RX_MAX + 1];

    FuriString* shown;
    char url[URL_MAX];

    /* Si el equipo no responde a tiempo, mostrar un error en vez de esperar para siempre. */
    FuriTimer* reply_timer;
    bool waiting;
} App;

/* ---------- utilidades de pantalla ---------- */

static void show_text(App* app, const char* text) {
    furi_string_set(app->shown, text);
    text_box_reset(app->text_box);
    text_box_set_font(app->text_box, TextBoxFontText);
    text_box_set_text(app->text_box, furi_string_get_cstr(app->shown));
    view_dispatcher_switch_to_view(app->view_dispatcher, ViewText);
}

static void send_to_phone(App* app, const char* msg) {
    if(!app->rpc) {
        show_text(
            app,
            "Sin conexion.\n\n"
            "Abre esta app desde\n"
            "'Flipper Puente' (PC o\n"
            "celular), pestana Internet.");
        return;
    }
    FuriString* wait = furi_string_alloc_printf("Pidiendo por internet...\n\n%s", msg);
    show_text(app, furi_string_get_cstr(wait));
    furi_string_free(wait);
    app->waiting = true;
    furi_timer_start(app->reply_timer, furi_ms_to_ticks(REPLY_TIMEOUT_MS));
    rpc_system_app_exchange_data(app->rpc, (const uint8_t*)msg, strlen(msg));
}

static void reply_timeout_callback(void* context) {
    App* app = context;
    view_dispatcher_send_custom_event(app->view_dispatcher, EvTimeout);
}

static void request_url(App* app, const char* url) {
    FuriString* msg = furi_string_alloc_printf("GET %s", url);
    send_to_phone(app, furi_string_get_cstr(msg));
    furi_string_free(msg);
}

/* ---------- RPC (llamado desde el hilo RPC) ---------- */

static void receive_bytes(App* app, const uint8_t* ptr, size_t size) {
    if(size > RX_MAX) size = RX_MAX;
    furi_mutex_acquire(app->rx_mutex, FuriWaitForever);
    if(size && ptr) memcpy(app->rx, ptr, size);
    app->rx[size] = '\0';
    furi_mutex_release(app->rx_mutex);
    rpc_system_app_confirm(app->rpc, true);
    view_dispatcher_send_custom_event(app->view_dispatcher, EvRxData);
}

static void rpc_callback(const RpcAppSystemEvent* event, void* context) {
    App* app = context;

    switch(event->type) {
    case RpcAppEventTypeSessionClose:
        view_dispatcher_send_custom_event(app->view_dispatcher, EvSessionClosed);
        break;
    case RpcAppEventTypeAppExit:
        rpc_system_app_confirm(app->rpc, true);
        view_dispatcher_send_custom_event(app->view_dispatcher, EvExit);
        break;
    case RpcAppEventTypeDataExchange:
        receive_bytes(app, event->data.bytes.ptr, event->data.bytes.size);
        break;
    default:
        // Todo evento con comando debe confirmarse o el RPC queda bloqueado.
        rpc_system_app_confirm(app->rpc, false);
        break;
    }
}

/* ---------- callbacks de la interfaz ---------- */

static void menu_callback(void* context, uint32_t index) {
    App* app = context;
    switch(index) {
    case MenuIp:
        request_url(app, "https://api.ipify.org");
        break;
    case MenuClima:
        request_url(app, "https://wttr.in/?format=3");
        break;
    case MenuChiste:
        request_url(app, "https://icanhazdadjoke.com/");
        break;
    case MenuUrl:
        view_dispatcher_switch_to_view(app->view_dispatcher, ViewInput);
        break;
    case MenuUltima:
        view_dispatcher_switch_to_view(app->view_dispatcher, ViewText);
        break;
    default:
        break;
    }
}

static void url_entered_callback(void* context) {
    App* app = context;
    view_dispatcher_send_custom_event(app->view_dispatcher, EvUrlEntered);
}

static uint32_t back_to_menu(void* context) {
    UNUSED(context);
    return ViewMenu;
}

static uint32_t exit_app(void* context) {
    UNUSED(context);
    return VIEW_NONE;
}

static bool navigation_callback(void* context) {
    UNUSED(context);
    return false;
}

static bool custom_event_callback(void* context, uint32_t event) {
    App* app = context;
    switch(event) {
    case EvRxData: {
        app->waiting = false;
        furi_timer_stop(app->reply_timer);
        furi_mutex_acquire(app->rx_mutex, FuriWaitForever);
        FuriString* copy = furi_string_alloc_set_str(app->rx);
        furi_mutex_release(app->rx_mutex);

        const char* data = furi_string_get_cstr(copy);
        if(strncmp(data, "OK ", 3) == 0) {
            const char* body = strchr(data, '\n');
            show_text(app, body ? body + 1 : "(respuesta vacia)");
        } else if(strncmp(data, "ERR ", 4) == 0) {
            FuriString* err = furi_string_alloc_printf("Error:\n%s", data + 4);
            show_text(app, furi_string_get_cstr(err));
            furi_string_free(err);
        } else if(strncmp(data, "MSG ", 4) == 0) {
            FuriString* msg = furi_string_alloc_printf("Mensaje recibido:\n\n%s", data + 4);
            show_text(app, furi_string_get_cstr(msg));
            furi_string_free(msg);
        } else {
            show_text(app, data);
        }
        furi_string_free(copy);
        notification_message(app->notifications, &sequence_single_vibro);
        return true;
    }
    case EvUrlEntered:
        request_url(app, app->url);
        return true;
    case EvTimeout:
        if(app->waiting) {
            app->waiting = false;
            show_text(
                app,
                "Sin respuesta.\n\n"
                "La PC/celular no contesto\n"
                "a tiempo. Revisa la app\n"
                "Flipper Puente y vuelve\n"
                "a intentarlo.\n\n"
                "Atras = menu");
        }
        return true;
    case EvSessionClosed:
        // El contexto RPC deja de ser válido: soltarlo antes de salir.
        furi_timer_stop(app->reply_timer);
        if(app->rpc) {
            rpc_system_app_set_callback(app->rpc, NULL, NULL);
            app->rpc = NULL;
        }
        view_dispatcher_stop(app->view_dispatcher);
        return true;
    case EvExit:
        view_dispatcher_stop(app->view_dispatcher);
        return true;
    default:
        return false;
    }
}

/* ---------- ciclo de vida ---------- */

static App* app_alloc(void) {
    App* app = malloc(sizeof(App));
    memset(app, 0, sizeof(App));

    app->rx_mutex = furi_mutex_alloc(FuriMutexTypeNormal);
    app->reply_timer = furi_timer_alloc(reply_timeout_callback, FuriTimerTypeOnce, app);
    app->shown = furi_string_alloc();
    strlcpy(app->url, "example.com", URL_MAX);

    app->gui = furi_record_open(RECORD_GUI);
    app->notifications = furi_record_open(RECORD_NOTIFICATION);

    app->view_dispatcher = view_dispatcher_alloc();
    view_dispatcher_set_event_callback_context(app->view_dispatcher, app);
    view_dispatcher_set_custom_event_callback(app->view_dispatcher, custom_event_callback);
    view_dispatcher_set_navigation_event_callback(app->view_dispatcher, navigation_callback);
    view_dispatcher_attach_to_gui(app->view_dispatcher, app->gui, ViewDispatcherTypeFullscreen);

    app->menu = submenu_alloc();
    submenu_add_item(app->menu, "Mi IP publica", MenuIp, menu_callback, app);
    submenu_add_item(app->menu, "Clima", MenuClima, menu_callback, app);
    submenu_add_item(app->menu, "Chiste (ingles)", MenuChiste, menu_callback, app);
    submenu_add_item(app->menu, "Abrir URL...", MenuUrl, menu_callback, app);
    submenu_add_item(app->menu, "Ver ultima respuesta", MenuUltima, menu_callback, app);
    view_set_previous_callback(submenu_get_view(app->menu), exit_app);
    view_dispatcher_add_view(app->view_dispatcher, ViewMenu, submenu_get_view(app->menu));

    app->text_box = text_box_alloc();
    view_set_previous_callback(text_box_get_view(app->text_box), back_to_menu);
    view_dispatcher_add_view(app->view_dispatcher, ViewText, text_box_get_view(app->text_box));

    app->text_input = text_input_alloc();
    text_input_set_header_text(app->text_input, "URL (sin https://)");
    text_input_set_result_callback(
        app->text_input, url_entered_callback, app, app->url, URL_MAX, false);
    view_set_previous_callback(text_input_get_view(app->text_input), back_to_menu);
    view_dispatcher_add_view(app->view_dispatcher, ViewInput, text_input_get_view(app->text_input));

    return app;
}

static void app_free(App* app) {
    furi_timer_stop(app->reply_timer);
    furi_timer_free(app->reply_timer);
    view_dispatcher_remove_view(app->view_dispatcher, ViewMenu);
    view_dispatcher_remove_view(app->view_dispatcher, ViewText);
    view_dispatcher_remove_view(app->view_dispatcher, ViewInput);
    submenu_free(app->menu);
    text_box_free(app->text_box);
    text_input_free(app->text_input);
    view_dispatcher_free(app->view_dispatcher);

    furi_record_close(RECORD_NOTIFICATION);
    furi_record_close(RECORD_GUI);

    furi_string_free(app->shown);
    furi_mutex_free(app->rx_mutex);
    free(app);
}

int32_t internet_bridge_app(void* p) {
    const char* args = p;
    App* app = app_alloc();

    if(args && strncmp(args, "RPC ", 4) == 0) {
        unsigned long ctx = 0;
        if(sscanf(args, "RPC %lX", &ctx) == 1 && ctx) {
            app->rpc = (RpcAppSystem*)ctx;
            rpc_system_app_set_callback(app->rpc, rpc_callback, app);
            rpc_system_app_send_started(app->rpc);
            const char* hello = "HELLO";
            rpc_system_app_exchange_data(app->rpc, (const uint8_t*)hello, strlen(hello));
        }
    }

    if(app->rpc) {
        view_dispatcher_switch_to_view(app->view_dispatcher, ViewMenu);
    } else {
        show_text(
            app,
            "Puente Internet\n\n"
            "Usa el internet de la PC\n"
            "(cable USB) o del celular\n"
            "(Bluetooth). Abrela desde\n"
            "'Flipper Puente', pestana\n"
            "Internet.\n\n"
            "Atras = ir al menu");
    }

    view_dispatcher_run(app->view_dispatcher);

    if(app->rpc) {
        rpc_system_app_send_exited(app->rpc);
        rpc_system_app_set_callback(app->rpc, NULL, NULL);
        app->rpc = NULL;
    }

    app_free(app);
    return 0;
}
