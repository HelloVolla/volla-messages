#define _GNU_SOURCE

#include <dlfcn.h>
#include <stdlib.h>
#include <stdio.h>

typedef void WebKitWebView;

void webkit_web_view_load_uri(WebKitWebView *view, const char *uri)
{
    static void (*real_load_uri)(WebKitWebView *, const char *) = NULL;
    static void (*set_zoom)(WebKitWebView *, double) = NULL;

    if (!real_load_uri)
        real_load_uri = dlsym(RTLD_NEXT, "webkit_web_view_load_uri");

    if (!set_zoom)
        set_zoom = dlsym(RTLD_NEXT, "webkit_web_view_set_zoom_level");

    double scale = 2.0; /* fallback */

    const char *grid_unit_px = getenv("GRID_UNIT_PX");

    if (grid_unit_px) {
        char *endptr;
        double grid = strtod(grid_unit_px, &endptr);

        if (endptr != grid_unit_px && grid > 0.0)
            scale = grid / 8.0;
    }

    fprintf(stderr,
            "[webkit-zoom] GRID_UNIT_PX=%s scale=%f\n",
            grid_unit_px ? grid_unit_px : "(null)",
            scale);

    if (set_zoom)
        set_zoom(view, scale);

    if (real_load_uri)
        real_load_uri(view, uri);
}