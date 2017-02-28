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

#ifndef ZI_ZARGS_ZARGS_HPP
#define ZI_ZARGS_ZARGS_HPP 1

#include <zi/zargs/arguments.hpp>
#include <zi/utility/exception.hpp>

#include <zi/bits/cstdint.hpp>

#define ZiARG_DEFINITION( _name, _default, _desc, _type, _type_str)     \
                                                                        \
    namespace __zi_arg_namespace_for_ ## _name {                        \
                                                                        \
        _type ZiARG_ ## _name = _default;                               \
        class arg_handler_ ## _name :                                   \
            public zi::zargs_::arguments::handler                       \
        {                                                               \
        private:                                                        \
            zi::zargs_::matcher< _type > matcher_;                      \
            zi::zargs_::parser < _type > parser_ ;                      \
                                                                        \
        public:                                                         \
                                                                        \
            arg_handler_ ## _name()                                     \
            {                                                           \
                zi::zargs_::arguments::instance().                      \
                    register_handler( this );                           \
            }                                                           \
                                                                        \
            std::string get_name() const                                \
            {                                                           \
                return #_name;                                          \
            }                                                           \
            std::string get_type() const                                \
            {                                                           \
                return #_type_str;                                      \
            }                                                           \
            std::string get_default() const                             \
            {                                                           \
                return #_default;                                       \
            }                                                           \
            std::string get_description() const                         \
            {                                                           \
                return _desc;                                           \
            }                                                           \
                                                                        \
            bool parse( std::list< std::string > &q )                   \
            {                                                           \
                if ( matcher_.match( #_name, q ) )                      \
                {                                                       \
                    std::string val = q.front();                        \
                    if ( !parser_.parse( &ZiARG_ ## _name, val ) )      \
                    {                                                   \
                        throw zi::exception                             \
                            ( get_name() + " [" + get_type() +          \
                              "] can't be parsed from" +                \
                              " \"" + val + "\"" );                     \
                    }                                                   \
                    return true;                                        \
                }                                                       \
                return false;                                           \
            }                                                           \
        };                                                              \
                                                                        \
        arg_handler_ ## _name arg_handler_ ## _name ## _inst;           \
    }                                                                   \
                                                                        \
    using __zi_arg_namespace_for_ ## _name::ZiARG_ ## _name


#define ZiARG_int32( _name, _default, _description )                    \
    ZiARG_DEFINITION( _name, _default, _description, int32_t,  INT32 )
#define ZiARG_uint32( _name, _default, _description )                   \
    ZiARG_DEFINITION( _name, _default, _description, uint32_t, UINT32 )
#define ZiARG_int64( _name, _default, _description )                    \
    ZiARG_DEFINITION( _name, _default, _description, int64_t,  INT64 )
#define ZiARG_uint64( _name, _default, _description )                   \
    ZiARG_DEFINITION( _name, _default, _description, uint64_t, INT64 )
#define ZiARG_float( _name, _default, _description )                    \
    ZiARG_DEFINITION( _name, _default, _description, float,    FLOAT )
#define ZiARG_double( _name, _default, _description )                   \
    ZiARG_DEFINITION( _name, _default, _description, double,   DOUBLE )
#define ZiARG_bool( _name, _default, _description )                     \
    ZiARG_DEFINITION( _name, _default, _description, bool,     BOOLEAN )
#define ZiARG_string( _name, _default, _description )                   \
    ZiARG_DEFINITION( _name, _default, _description, std::string, STRING )

#define ZIARG_SET_DEF( _name, _type, _types, _desc )            \
    ZiARG_DEFINITION( _name, std::set< _type >(),               \
                      _desc, std::set< _type >, _types )

#define ZiARG_int32_set( _name, _desc )                 \
    ZIARG_SET_DEF( _name, int32_t, INT32_SET, _desc )
#define ZiARG_uint32_set( _name, _desc )                \
    ZIARG_SET_DEF( _name, uint32_t, UINT32_SET, _desc )
#define ZiARG_int64_set( _name, _desc )                 \
    ZIARG_SET_DEF( _name, int64_t, INT64_SET, _desc )
#define ZiARG_uint64_set( _name, _desc )                \
    ZIARG_SET_DEF( _name, uint64_t, UINT64_SET, _desc )
#define ZiARG_float_set( _name, _desc )                 \
    ZIARG_SET_DEF( _name, float, FLOAT_SET, _desc )
#define ZiARG_double_set( _name, _desc )                \
    ZIARG_SET_DEF( _name, double, DOUBLE_SET, _desc )
#define ZiARG_string_set( _name, _desc )                        \
    ZIARG_SET_DEF( _name, std::string, STRING_SET, _desc )

#define ZIARG_LIST_DEF( _name, _type, _types, _desc )           \
    ZiARG_DEFINITION( _name, std::vector< _type >(),            \
                      _desc, std::vector< _type >, _types )

#define ZiARG_int32_list( _name, _desc )                \
    ZIARG_LIST_DEF( _name, int32_t, INT32_LIST, _desc )
#define ZiARG_uint32_list( _name, _desc )                       \
    ZIARG_LIST_DEF( _name, uint32_t, UINT32_LIST, _desc )
#define ZiARG_int64_list( _name, _desc )                \
    ZIARG_LIST_DEF( _name, int64_t, INT64_LIST, _desc )
#define ZiARG_uint64_list( _name, _desc )                       \
    ZIARG_LIST_DEF( _name, uint64_t, UINT64_LIST, _desc )
#define ZiARG_float_list( _name, _desc )                \
    ZIARG_LIST_DEF( _name, float, FLOAT_LIST, _desc )
#define ZiARG_double_list( _name, _desc )               \
    ZIARG_LIST_DEF( _name, double, DOUBLE_LIST, _desc )
#define ZiARG_string_list( _name, _desc )                       \
    ZIARG_LIST_DEF( _name, std::string, STRING_LIST, _desc )

#define ZiARG_enabled( _name, _desc )                           \
    namespace __zi_arg_namespace_for_ ## _name {                \
        typedef std::map< std::string, bool > property_map;     \
    }                                                           \
    using __zi_arg_namespace_for_ ## _name::property_map;       \
    ZiARG_DEFINITION( _name, property_map(),                    \
                      _desc, property_map, STRING_LIST )


#define __ZiARG_DECL( _name, _type )                            \
    namespace __zi_arg_namespace_for_ ## _name {                \
        extern _type ZiARG_ ## _name;                           \
    }                                                           \
    using __zi_arg_namespace_for_ ## _name::ZiARG_ ## _name

#define DECLARE_ZiARG_int32( _name )  __ZiARG_DECL( _name, int32_t  )
#define DECLARE_ZiARG_uint32( _name ) __ZiARG_DECL( _name, uint32_t )
#define DECLARE_ZiARG_int64( _name )  __ZiARG_DECL( _name, int64_t  )
#define DECLARE_ZiARG_uint64( _name ) __ZiARG_DECL( _name, uint64_t )
#define DECLARE_ZiARG_float( _name )  __ZiARG_DECL( _name, float    )
#define DECLARE_ZiARG_double( _name ) __ZiARG_DECL( _name, double   )
#define DECLARE_ZiARG_string( _name ) __ZiARG_DECL( _name, string   )
#define DECLARE_ZiARG_bool( _name )   __ZiARG_DECL( _name, bool     )

#define __ZiARG_DECL_SET( _name, _type )        \
    __ZiARG_DECL( _name, std::set< _type > )

#define DECLARE_ZiARG_int32_set( _name )  __ZiARG_DECL_SET( _name, int32_t  )
#define DECLARE_ZiARG_uint32_set( _name ) __ZiARG_DECL_SET( _name, uint32_t )
#define DECLARE_ZiARG_int64_set( _name )  __ZiARG_DECL_SET( _name, int64_t  )
#define DECLARE_ZiARG_uint64_set( _name ) __ZiARG_DECL_SET( _name, uint64_t )
#define DECLARE_ZiARG_float_set( _name )  __ZiARG_DECL_SET( _name, float    )
#define DECLARE_ZiARG_double_set( _name ) __ZiARG_DECL_SET( _name, double   )
#define DECLARE_ZiARG_string_set( _name ) __ZiARG_DECL_SET( _name, string   )

#define __ZiARG_DECL_LIST( _name, _type )        \
    __ZiARG_DECL( _name, std::vector< _type > )

#define DECLARE_ZiARG_int32_list( _name )  __ZiARG_DECL_LIST( _name, int32_t  )
#define DECLARE_ZiARG_uint32_list( _name ) __ZiARG_DECL_LIST( _name, uint32_t )
#define DECLARE_ZiARG_int64_list( _name )  __ZiARG_DECL_LIST( _name, int64_t  )
#define DECLARE_ZiARG_uint64_list( _name ) __ZiARG_DECL_LIST( _name, uint64_t )
#define DECLARE_ZiARG_float_list( _name )  __ZiARG_DECL_LIST( _name, float    )
#define DECLARE_ZiARG_double_list( _name ) __ZiARG_DECL_LIST( _name, double   )
#define DECLARE_ZiARG_string_list( _name ) __ZiARG_DECL_LIST( _name, string   )

#define DECLARE_ZiARG_enabled( _name )                          \
    namespace __zi_arg_namespace_for_ ## _name {                \
        extern std::map< std::string, bool > property_map;      \
    }                                                           \
    using __zi_arg_namespace_for_ ## _name::property_map


// TODO: nicer default values for lists/sets/...

#endif

