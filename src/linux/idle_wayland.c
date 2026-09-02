#define _POSIX_C_SOURCE 200809L

#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <wayland-client.h>

#include "ext-idle-notify-v1-client-protocol.h"

static atomic_uint_fast64_t idle_since_ms = 0;
static atomic_int monitor_started = 0;
static struct wl_seat *seat = NULL;
static struct ext_idle_notifier_v1 *notifier = NULL;

static uint64_t monotonic_ms(void) {
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return 0;
    return (uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u;
}

static void became_idle(void *data, struct ext_idle_notification_v1 *notification) {
    (void)data;
    (void)notification;
    uint64_t now = monotonic_ms();
    atomic_store(&idle_since_ms, now > 1000u ? now - 1000u : 1u);
}

static void became_active(void *data, struct ext_idle_notification_v1 *notification) {
    (void)data;
    (void)notification;
    atomic_store(&idle_since_ms, 0);
}

static const struct ext_idle_notification_v1_listener idle_listener = {
    .idled = became_idle,
    .resumed = became_active,
};

static void registry_global(void *data, struct wl_registry *registry, uint32_t name,
                            const char *interface, uint32_t version) {
    (void)data;
    if (strcmp(interface, wl_seat_interface.name) == 0 && seat == NULL) {
        uint32_t bind_version = version < 5u ? version : 5u;
        seat = wl_registry_bind(registry, name, &wl_seat_interface, bind_version);
    } else if (strcmp(interface, ext_idle_notifier_v1_interface.name) == 0 && notifier == NULL) {
        notifier = wl_registry_bind(registry, name, &ext_idle_notifier_v1_interface, 1u);
    }
}

static void registry_remove(void *data, struct wl_registry *registry, uint32_t name) {
    (void)data;
    (void)registry;
    (void)name;
}

static const struct wl_registry_listener registry_listener = {
    .global = registry_global,
    .global_remove = registry_remove,
};

static void *monitor_thread(void *unused) {
    (void)unused;
    struct wl_display *display = wl_display_connect(NULL);
    if (display == NULL) return NULL;

    struct wl_registry *registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    if (wl_display_roundtrip(display) < 0 || seat == NULL || notifier == NULL) {
        wl_registry_destroy(registry);
        wl_display_disconnect(display);
        return NULL;
    }

    struct ext_idle_notification_v1 *notification =
        ext_idle_notifier_v1_get_idle_notification(notifier, 1000u, seat);
    ext_idle_notification_v1_add_listener(notification, &idle_listener, NULL);

    while (wl_display_dispatch(display) >= 0) {}

    atomic_store(&idle_since_ms, 0);
    ext_idle_notification_v1_destroy(notification);
    ext_idle_notifier_v1_destroy(notifier);
    wl_seat_destroy(seat);
    wl_registry_destroy(registry);
    wl_display_disconnect(display);
    return NULL;
}

int clocked_idle_start(void) {
    if (atomic_exchange(&monitor_started, 1) != 0) return 0;
    pthread_t thread;
    int rc = pthread_create(&thread, NULL, monitor_thread, NULL);
    if (rc != 0) {
        atomic_store(&monitor_started, 0);
        return rc;
    }
    pthread_detach(thread);
    return 0;
}

uint64_t clocked_idle_millis(void) {
    uint64_t since = atomic_load(&idle_since_ms);
    if (since == 0) return 0;
    uint64_t now = monotonic_ms();
    return now > since ? now - since : 0;
}
