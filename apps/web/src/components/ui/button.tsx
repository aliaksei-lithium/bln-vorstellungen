import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import { cn } from '@/lib/utils';

/** shadcn Button, restyled for direction D: square, 1px ink frame, 44px tap targets. */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 border font-bold whitespace-nowrap select-none transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-5",
  {
    variants: {
      variant: {
        default: 'border-primary bg-primary text-primary-foreground font-extrabold hover:brightness-110',
        outline: 'border-ink bg-surface text-ink hover:bg-chip aria-pressed:bg-ink aria-pressed:text-on-ink',
        dark: 'border-ink bg-ink text-on-ink',
        ghost: 'border-transparent bg-transparent text-ink hover:bg-chip',
        link: 'border-transparent text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'min-h-11 px-3.5 text-[14.5px]',
        sm: 'min-h-9 px-3 text-[13.5px]',
        lg: 'min-h-14 px-4 text-[15px]',
        icon: 'size-11',
      },
    },
    defaultVariants: { variant: 'outline', size: 'default' },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'button';
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
