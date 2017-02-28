//
// Copyright (C) 2010  Aleksandar Zlateski <zlateski@mit.edu>
// ----------------------------------------------------------
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <http://www.gnu.org/licenses/>.
//

#ifndef ZI_ZLOG_ZLOG_HPP
#define ZI_ZLOG_ZLOG_HPP 1

#include <zi/zargs/zargs.hpp>
#include <zi/zlog/log_printf.hpp>
#include <zi/zlog/logs.hpp>
#include <zi/zlog/registry.hpp>

namespace zi {
namespace zlog {

extern void call_ZiLOGGING_macro_only_once();
extern void ZiLOG_default_already_defined();

struct ZiLOGGING_call
{
    ZiLOGGING_call()
    {
        std::ios_base::sync_with_stdio( false );
    }
};

} // namespace zlog
} // namespace zi

#define ZiLOGGING_CALL_ONCE_NICE_ERROR()                \
    namespace zi {                                      \
        namespace zlog {                                \
            void call_ZiLOGGING_macro_only_once() {}    \
            void ZiLOG_default_already_defined() {}     \
        }                                               \
    }

#define ZiLOGGING_DEFAULT()                                             \
    ZiLOGGING_CALL_ONCE_NICE_ERROR()                                    \
    static ::zi::zlog::ZiLOGGING_call ____ZiLOGGING_called_here____

#define ZiLOGGING_STDOUT()                                              \
    ZiLOGGING_CALL_ONCE_NICE_ERROR()                                    \
    static ::zi::zlog::log_sinks::all_cout_initializer ___zlog_init___; \
    static ::zi::zlog::ZiLOGGING_call ____ZiLOGGING_called_here____

#define ZiLOGGING_STDERR()                                              \
    ZiLOGGING_CALL_ONCE_NICE_ERROR()                                    \
    static ::zi::zlog::log_sinks::all_cerr_initializer ___zlog_init___; \
    static ::zi::zlog::ZiLOGGING_call ____ZiLOGGING_called_here____

#define ZiLOGGING_STDLOG()                                              \
    ZiLOGGING_CALL_ONCE_NICE_ERROR()                                    \
    static ::zi::zlog::log_sinks::all_clog_initializer ___zlog_init___; \
    static ::zi::zlog::ZiLOGGING_call ____ZiLOGGING_called_here____

#define ZiLOGGING_FILES()                                               \
    ZiLOGGING_CALL_ONCE_NICE_ERROR()                                    \
    static ::zi::zlog::log_sinks::file_initializer ____zlog_init____;   \
    static ::zi::zlog::ZiLOGGING_call ____ZiLOGGING_called_here____


#define ZiLOGGING_1( x, ... ) ZiLOGGING_##x()
#define ZiLOGGING_0( x, ... ) ZiLOGGING_1( __VA_ARGS__ )
#define ZiLOGGING( ... ) ZiLOGGING_0( ~, ##__VA_ARGS__, DEFAULT )

// support any of these instead of ZiLOGGING( ... )
#define USE_ZiLOGGING( ... )  ZiLOGGING( __VA_ARGS__ )
#define INIT_ZiLOGGING( ... ) ZiLOGGING( __VA_ARGS__ )

#define ZiLOG_ZiARGs_NAMESPACE_1( x, l ) x##l
#define ZiLOG_ZiARGs_NAMESPACE_0( x, l ) ZiLOG_ZiARGs_NAMESPACE_1( x, l )
#define ZiLOG_ZiARGs_NAMESPACE( x ) ZiLOG_ZiARGs_NAMESPACE_0( x, __LINE__ )

#define DEFINE_ZiLOG_IMPL( name, def, ... )                             \
    namespace zi {                                                      \
        namespace zlog {                                                \
            extern void ERROR_ZiLOG_##name##_already_defined();         \
            void ERROR_ZiLOG_##name##_already_defined() {}              \
        }                                                               \
    }                                                                   \
                                                                        \
    /* hide the ZiARG multiple definition error! */                     \
    namespace ZiLOG_ZiARGs_NAMESPACE( name ) {                          \
        ZiARG_bool( log##name, def, "Whether to log " #name );          \
    }                                                                   \
                                                                        \
    static ::zi::zlog::registry::signup                                 \
    ____ERROR_zi_log_##name##_already_defined____                       \
    ( #name, &ZiLOG_ZiARGs_NAMESPACE( name )::ZiARG_log##name )


#define DEFINE_ZiLOG( x, ... ) DEFINE_ZiLOG_IMPL( x, ##__VA_ARGS__, true )


#define IF_ZiLOG( name ) IF_ZiLOG_IMPL( #name )
#define IF_ZiLOG_IMPL( name )                                   \
    for ( int ____i = 0, ____active = 0; ____i < 2; ++____i )   \
        if ( ____i == 0 )                                       \
        {                                                       \
            static const bool* ____active_ptr =                 \
                ::zi::zlog::registry::is_active( name );        \
            ____active = *____active_ptr;                       \
        }                                                       \
        else                                                    \
            if ( ____active )


#define ZiLOG( _type, ... ) ZiLOG_ ## _type( __VA_ARGS__ )

#define ZiLOG_DEBUG_IMPL( name, ... )                                   \
    IF_ZiLOG_IMPL( name )                                               \
    ::zi::zlog::token_wrapper( *::zi::zlog::log_sinks_.debug_ ).get()   \
    << "DEBUG" << "(" name ")" << ::zi::zlog::log_printf( __VA_ARGS__ )

#define ZiLOG_DEBUG_0( x, ... ) ZiLOG_DEBUG_IMPL( #x, __VA_ARGS__)

#if defined( NDEBUG )
#  define ZiLOG_DEBUG( ... ) if ( false ) std::cout
#else
#  define ZiLOG_DEBUG( ... ) ZiLOG_DEBUG_0( __VA_ARGS__ )
#endif

#define ZiLOG_INFO_IMPL( name, ... )                                    \
    IF_ZiLOG_IMPL( name )                                               \
    ::zi::zlog::token_wrapper( *::zi::zlog::log_sinks_.info_ ).get()    \
    << "INFO" << "(" name ")" << ::zi::zlog::log_printf( __VA_ARGS__ )

#define ZiLOG_INFO_0( x, ... ) ZiLOG_INFO_IMPL( #x, __VA_ARGS__ )
#define ZiLOG_INFO( ... ) ZiLOG_INFO_0( __VA_ARGS__ )

#define ZiLOG_WARNING_IMPL( name, ... )                                 \
    IF_ZiLOG_IMPL( name )                                               \
    ::zi::zlog::token_wrapper( *::zi::zlog::log_sinks_.warning_ ).get() \
    << "WARNING" << "(" name ")" << ::zi::zlog::log_printf( __VA_ARGS__ )

#define ZiLOG_WARNING_0( x, ... ) ZiLOG_WARNING_IMPL( #x, __VA_ARGS__ )
#define ZiLOG_WARNING( ... ) ZiLOG_WARNING_0( __VA_ARGS__ )

#define ZiLOG_ERROR_IMPL( name, ... )                                   \
    IF_ZiLOG_IMPL( name )                                               \
    ::zi::zlog::token_wrapper( *::zi::zlog::log_sinks_.error_ ).get()   \
    << "ERROR" << "(" name ")" << ::zi::zlog::log_printf( __VA_ARGS__ )

#define ZiLOG_ERROR_0( x, ... ) ZiLOG_ERROR_IMPL( #x, __VA_ARGS__ )
#define ZiLOG_ERROR( ... ) ZiLOG_ERROR_0( __VA_ARGS__ )


#endif

