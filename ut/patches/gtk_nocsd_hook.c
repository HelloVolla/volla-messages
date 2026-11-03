#define _GNU_SOURCE

#include <dlfcn.h>
#include <stddef.h>

typedef void GtkWindow;

void gtk_window_set_decorated(GtkWindow *window, int setting)
{
    static void (*real_set_decorated)(GtkWindow *, int) = NULL;

    if (!real_set_decorated)
        real_set_decorated = dlsym(RTLD_NEXT, "gtk_window_set_decorated");

    (void)setting;

    if (real_set_decorated)
        real_set_decorated(window, 0);
}
