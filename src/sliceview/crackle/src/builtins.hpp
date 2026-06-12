#ifndef _CRACKLE_BUILTINS_HXX_
#define _CRACKLE_BUILTINS_HXX_

#ifdef _MSC_VER
#  include <intrin.h>
#  define popcount __popcnt
#else
#  define popcount __builtin_popcount
#endif

#endif