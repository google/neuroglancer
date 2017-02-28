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

#ifndef ZI_UTILITY_NATURAL_COMPARE_HPP
#define ZI_UTILITY_NATURAL_COMPARE_HPP 1

#include <functional>
#include <iterator>
#include <locale>

namespace zi {

template< class CharCompare >
class natural_compare
{
private:
    CharCompare compare_;
    std::locale locale_ ;

    template< class Iterator >
    int compare_to_right( Iterator& abeg, Iterator aend,
                          Iterator& bbeg, Iterator bend ) const
    {
        typedef typename std::iterator_traits< Iterator >::value_type value_type;

        for ( int res = 0 ;; ++abeg, ++bbeg )
        {
            value_type ca = ( abeg != aend ) ? *abeg : value_type();
            value_type cb = ( bbeg != bend ) ? *bbeg : value_type();

            bool da = std::isdigit( ca, locale_ );
            bool db = std::isdigit( cb, locale_ );

            if ( !da && !db )
            {
                return res;
            }

            else if ( !da )
            {
                return compare_( 0, 1 ) ? 1 : -1;
            }
            else if ( !db )
            {
                return compare_( 0, 1 ) ? -1 : 1;
            }
            else if ( res == 0 )
            {
                if ( compare_( ca, cb ) )
                {
                    res = 1;
                }
                else if ( compare_( cb, ca ) )
                {
                    res = -1;
                }
            }
            else if ( bbeg == bend && abeg == aend )
            {
                return res;
            }
        }
    }

public:
    natural_compare(): compare_(), locale_()
    { }

    template< class T >
    bool operator()( const T& a, const T& b ) const
    {
        typedef typename T::const_iterator const_iterator;
        typedef typename std::iterator_traits< const_iterator >::value_type value_type;

        std::equal_to< value_type > equals;

        for ( const_iterator ia = a.begin(), ib = b.begin();; ++ia, ++ib )
        {

            value_type ca = value_type();
            value_type cb = value_type();

            if ( ia != a.end() )
            {
                ca = *ia;
            }

            if ( ib != b.end() )
            {
                cb = *ib;
            }

            while ( std::isspace( ca, locale_ ) || equals( ca, '0' ))
            {
                ca = ( ++ia == a.end() ) ? value_type() : *ia;
            }

            while ( std::isspace( cb, locale_ ) || equals( cb, '0' ))
            {
                cb = ( ++ib == b.end() ) ? value_type() : *ib;
            }

            if ( std::isdigit( ca, locale_ ) && std::isdigit( cb, locale_ ) )
            {
                int result = compare_to_right( ia, a.end(), ib, b.end() );
                if ( result )
                {
                    return result > 0;
                }
            }

            if ( ia == a.end() && ib == b.end() )
            {
                return std::lexicographical_compare( a.begin(), a.end(),
                                                     b.begin(), b.end(), compare_ );
            }

            if ( compare_( ca, cb ) )
            {
                return true;
            }

            if ( compare_( cb, ca ) )
            {
                return false;
            }
        }
    }

};

template< class CharType >
struct naturally_less
    : natural_compare< std::less< CharType > >
{ };

template< class CharType >
struct naturally_less< std::basic_string< CharType > >
    : natural_compare< std::less< CharType > >
{ };

template< class CharType >
struct naturally_greater
    : natural_compare< std::greater< CharType > >
{ };

template< class CharType >
struct naturally_greater< std::basic_string< CharType > >
    : natural_compare< std::greater< CharType > >
{ };

} // namespace zi

#endif

