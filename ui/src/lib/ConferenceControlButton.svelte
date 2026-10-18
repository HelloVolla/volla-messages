<script lang="ts">
  import SvgIcon from "$lib/SvgIcon.svelte";

  export let icon: string;
  export let label: string = "";
  export let active: boolean = false;
  export let disabled: boolean = false;
  export let size: "sm" | "md" | "lg" = "md";
  export let variant: "primary" | "secondary" | "danger" | "ghost" = "secondary";
  export let showLabel: boolean = false;
  export let title: string = "";

  function getBackgroundClasses(): string {
    if (disabled) return "bg-secondary-400/50 cursor-not-allowed";

    if (variant === "danger") {
      return "bg-primary-500 hover:bg-primary-600 shadow-lg shadow-primary-500/30";
    }

    if (variant === "primary") {
      return active
        ? "bg-primary-500 hover:bg-primary-600 shadow-lg shadow-primary-500/25"
        : "bg-secondary-400 hover:bg-secondary-300";
    }

    // Secondary and ghost variants
    if (active) {
      return "bg-error-500 hover:bg-error-600";
    }

    if (variant === "ghost") {
      return "bg-secondary-400/50 hover:bg-secondary-400 backdrop-blur-sm";
    }

    return "bg-secondary-400 hover:bg-secondary-300";
  }

  function getSizeClasses(): string {
    switch (size) {
      case "sm":
        return "h-[clamp(40px,10vw,44px)] w-[clamp(40px,10vw,44px)] sm:h-11 sm:w-11";
      case "lg":
        return "h-[clamp(48px,13vw,56px)] w-[clamp(48px,13vw,56px)] sm:h-14 sm:w-14 md:h-16 md:w-16";
      default:
        return "h-[52px] w-[52px] md:h-14 md:w-14";
    }
  }

  function getIconClasses(): string {
    switch (size) {
      case "sm":
        return "h-4 w-4 sm:h-5 sm:w-5";
      case "lg":
        return "h-5 w-5 sm:h-6 sm:w-6 md:h-7 md:w-7";
      default:
        return "h-[22px] w-[22px] md:h-6 md:w-6";
    }
  }

  $: bgClasses = getBackgroundClasses();
  $: sizeClasses = getSizeClasses();
  $: iconClasses = getIconClasses();
  $: textColor = disabled ? "text-tertiary-400" : "text-white";
</script>

<div class="flex flex-shrink-0 flex-col items-center gap-1">
  <button
    on:click
    class="group flex items-center justify-center rounded-2xl transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-white/50 focus:ring-offset-2 focus:ring-offset-secondary-500 {bgClasses} {sizeClasses}
      {disabled ? 'opacity-40' : 'hover:scale-105 active:scale-95'}"
    {disabled}
    {title}
    aria-label={label || title}
    aria-pressed={active}
  >
    <SvgIcon
      {icon}
      moreClasses="{iconClasses} {textColor} transition-transform group-hover:scale-110"
    />
  </button>

  {#if showLabel && label}
    <span class="text-[10px] font-medium text-tertiary-500 sm:text-xs">{label}</span>
  {/if}
</div>
