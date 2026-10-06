#define _GNU_SOURCE

#include <dlfcn.h>
#include <stdlib.h>
#include <stdio.h>

typedef void WebKitWebView;

static double grid_scale(void)
{
    double scale = 2.0; /* fallback */

    const char *grid_unit_px = getenv("GRID_UNIT_PX");

    if (grid_unit_px) {
        char *endptr;
        double grid = strtod(grid_unit_px, &endptr);

        if (endptr != grid_unit_px && grid > 0.0)
            scale = grid / 8.0;
    }

    return scale;
}

void webkit_web_view_set_zoom_level(WebKitWebView *view, double level)
{
    static void (*real_set_zoom)(WebKitWebView *, double) = NULL;

    if (!real_set_zoom)
        real_set_zoom = dlsym(RTLD_NEXT, "webkit_web_view_set_zoom_level");

    if (real_set_zoom)
        real_set_zoom(view, level * grid_scale());
}

void webkit_web_view_load_uri(WebKitWebView *view, const char *uri)
{
    static void (*real_load_uri)(WebKitWebView *, const char *) = NULL;

    if (!real_load_uri)
        real_load_uri = dlsym(RTLD_NEXT, "webkit_web_view_load_uri");

    webkit_web_view_set_zoom_level(view, 1.0);

    if (real_load_uri)
        real_load_uri(view, uri);
}

void webkit_web_view_load_request(WebKitWebView *view, void *request)
{
    static void (*real_load_request)(WebKitWebView *, void *) = NULL;

    if (!real_load_request)
        real_load_request = dlsym(RTLD_NEXT, "webkit_web_view_load_request");

    webkit_web_view_set_zoom_level(view, 1.0);

    if (real_load_request)
        real_load_request(view, request);
}

void webkit_web_view_load_html(WebKitWebView *view, const char *content, const char *base_uri)
{
    static void (*real_load_html)(WebKitWebView *, const char *, const char *) = NULL;

    if (!real_load_html)
        real_load_html = dlsym(RTLD_NEXT, "webkit_web_view_load_html");

    webkit_web_view_set_zoom_level(view, 1.0);

    if (real_load_html)
        real_load_html(view, content, base_uri);
}
