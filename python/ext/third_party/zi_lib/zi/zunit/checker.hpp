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

#ifndef ZI_ZUNIT_CHECKER_HPP
#define ZI_ZUNIT_CHECKER_HPP 1

#include <zi/zunit/config.hpp>
#include <zi/zunit/exception.hpp>

#include <zi/debug/printable_value.hpp>
#include <zi/debug/printable_type.hpp>

#include <string>

namespace zi {
namespace zunit {
namespace detail {

class checker
{
protected:
    bool passed_;

public:
    checker( bool v ): passed_( v )
    {
    }

    checker(): passed_( true )
    {
    }

    virtual ~checker()
    {
    }

    virtual operator bool() const
    {
        return passed_;
    }
};

} // namespace detail

#define ZUNIT_MAKE_UNARY_CHECKER( name, fn )            \
    struct name: detail::checker                        \
    {                                                   \
        template< class T > explicit name( T val ):     \
            detail::checker( fn( val ) )                \
        {                                               \
            if ( !passed_ )                             \
            {                                           \
                value_ = debug::printable_value( val ); \
                type_  = debug::printable_type ( val ); \
            }                                           \
        }                                               \
                                                        \
        std::string value_;                             \
        std::string type_ ;                             \
    }

ZUNIT_MAKE_UNARY_CHECKER(TRUE_checker ,  0 != );
ZUNIT_MAKE_UNARY_CHECKER(FALSE_checker,  0 == );

#undef ZUNIT_MAKE_UNARY_CHECKER

#define ZUNIT_MAKE_BINARY_CHECKER(name, op)                     \
    struct name: detail::checker                                \
    {                                                           \
        template< class L, class R > explicit name( L l, R r ): \
            detail::checker( (l) op (r) )                       \
        {                                                       \
            if ( !passed_ )                                     \
            {                                                   \
                lvalue_ = debug::printable_value( l );          \
                rvalue_ = debug::printable_value( r );          \
                ltype_  = debug::printable_type ( l );          \
                rtype_  = debug::printable_type ( r );          \
            }                                                   \
        }                                                       \
                                                                \
        std::string lvalue_, rvalue_, ltype_, rtype_;           \
    }

ZUNIT_MAKE_BINARY_CHECKER(EQ_checker , ==);
ZUNIT_MAKE_BINARY_CHECKER(NEQ_checker, !=);
ZUNIT_MAKE_BINARY_CHECKER(LT_checker , < );
ZUNIT_MAKE_BINARY_CHECKER(LTE_checker, <=);
ZUNIT_MAKE_BINARY_CHECKER(GT_checker , > );
ZUNIT_MAKE_BINARY_CHECKER(GTE_checker, >=);
ZUNIT_MAKE_BINARY_CHECKER(OR_checker , ||);

#undef ZUNIT_MAKE_BINARY_CHECKER

class unary_check_exception: public exception
{
public:
    unary_check_exception( const std::string &check,
                           const std::string &arg,
                           const std::string &arg_value,
                           const std::string &arg_type,
                           test_case *test, int line ):
        exception( exception::UNARY_CHECK, test, check, line ),
        arg_( arg ),
        arg_val_( arg_value ),
        arg_type_( arg_type )
    {
    }

    ~unary_check_exception() throw()
    {
    }

    const char* arg      ( int ) const { return arg_.c_str();      }
    const char* arg_value( int ) const { return arg_val_.c_str();  }
    const char* arg_type ( int ) const { return arg_type_.c_str(); }

private:
    const std::string arg_, arg_val_, arg_type_;

};

class binary_check_exception: public exception
{
public:
    binary_check_exception( const std::string &check,
                            const std::string &larg, const std::string &rarg,
                            const std::string &lval, const std::string &rval,
                            const std::string &ltpe, const std::string &rtpe,
                            test_case *test, int line ):
        exception( exception::BINARY_CHECK, test, check, line ),
        larg_( larg ),
        lval_( lval ),
        ltpe_( ltpe ),
        rarg_( rarg ),
        rval_( rval ),
        rtpe_( rtpe )
    {
    }

    ~binary_check_exception() throw()
    {
    }

    const char* arg      ( int i ) const { return i ? rarg_.c_str() : larg_.c_str(); }
    const char* arg_value( int i ) const { return i ? rval_.c_str() : lval_.c_str(); }
    const char* arg_type ( int i ) const { return i ? rtpe_.c_str() : ltpe_.c_str(); }

private:
    const std::string larg_, lval_, ltpe_, rarg_, rval_, rtpe_;

};

class throw_check_exception: public exception
{
public:
    throw_check_exception( const std::string &check, const std::string &what,
                           const char* larg, const char* rarg,
                           test_case *test, int line ):
        exception( exception::THROW_CHECK, test, check, what, line ),
        larg_( larg ),
        rarg_( rarg )
    {
    }

    ~throw_check_exception() throw()
    {
    }

    const char* arg( int i ) const { return i ? rarg_ : larg_; }

private:
    const char* larg_;
    const char* rarg_;

};


} // namespace zunit
} // namespace zi

#endif
