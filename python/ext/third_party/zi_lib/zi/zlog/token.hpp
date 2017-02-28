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

#ifndef ZI_ZLOG_TOKEN_HPP
#define ZI_ZLOG_TOKEN_HPP 1

#include <zi/utility/non_copyable.hpp>
#include <zi/utility/enable_if.hpp>
#include <zi/utility/is_printable.hpp>
#include <zi/utility/address_of.hpp>
#include <zi/debug/printable_type.hpp>
#include <zi/time/now.hpp>
#include <zi/bits/cstdint.hpp>

#include <sstream>

namespace zi {
namespace zlog {

// forward declaration
class sink;

class token: non_copyable
{
private:
    typedef std::ios_base& (ios_base_manipulator)( std::ios_base& );

    bool               done_;
    std::ostringstream out_ ;

    token(): done_( false ), out_()
    {
        out_ << zi::now::usec();
    }

    void mark_done()
    {
        done_ = true;
    }

    bool is_done() const
    {
        return done_;
    }

    friend class sink;

public:

    token&
    operator<< ( ios_base_manipulator& manipulator )
    {
        manipulator( out_ );
        return *this;
    }

    template< class T >
    typename enable_if< is_printable< T >::value, token& >::type
    operator<< ( const T& v )
    {
        out_ << "\t" << v;
        return *this;
    }

    template< class T >
    typename disable_if< is_printable< T >::value, token& >::type
    operator<< ( const T& v )
    {
        out_ << "\t< " << debug::printable_type< T >() << " @"
             << address_of( v ) << ">";
        return *this;
    }

};

} // namespace zlog
} // namespace zi

#endif

